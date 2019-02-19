import dotProp from 'dot-prop-immutable';
import debug from 'debug';
import NodeCache from 'node-cache';
import merge from 'deepmerge';
import AWS from 'aws-sdk';

const log = debug('reroute:log');
log.log = console.log.bind(console);

class Cache {
  constructor(ttlSeconds) {
    this.cache = new NodeCache({
      stdTTL: ttlSeconds,
      checkperiod: ttlSeconds * 0.2,
      useClones: false
    });
    this.ttl = ttlSeconds;
  }

  get(key, storeFunction) {
    if (this.ttl > 0) {
      const value = this.cache.get(key);

      if (value) {
        return Promise.resolve(value);
      }
    }

    return storeFunction().then(result => {
      this.ttl > 0 && this.cache.set(key, result, this.ttl);
      return result;
    });
  }

  del(keys) {
    this.cache.del(keys);
  }

  setDefaultTtl(ttl) {
    this.ttl = ttl;
    this.ttl === 0 && this.flush();
  }

  delStartWith(startStr = '') {
    if (!startStr) {
      return;
    }

    const keys = this.cache.keys();

    for (const key of keys) {
      if (key.indexOf(startStr) === 0) {
        this.del(key);
      }
    }
  }

  flush() {
    this.cache.flushAll();
  }

}

function _defineProperty(obj, key, value) {
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    obj[key] = value;
  }

  return obj;
}

function _objectSpread(target) {
  for (var i = 1; i < arguments.length; i++) {
    var source = arguments[i] != null ? arguments[i] : {};
    var ownKeys = Object.keys(source);

    if (typeof Object.getOwnPropertySymbols === 'function') {
      ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(source).filter(function (sym) {
        return Object.getOwnPropertyDescriptor(source, sym).enumerable;
      }));
    }

    ownKeys.forEach(function (key) {
      _defineProperty(target, key, source[key]);
    });
  }

  return target;
}

function _objectWithoutPropertiesLoose(source, excluded) {
  if (source == null) return {};
  var target = {};
  var sourceKeys = Object.keys(source);
  var key, i;

  for (i = 0; i < sourceKeys.length; i++) {
    key = sourceKeys[i];
    if (excluded.indexOf(key) >= 0) continue;
    target[key] = source[key];
  }

  return target;
}

function _objectWithoutProperties(source, excluded) {
  if (source == null) return {};

  var target = _objectWithoutPropertiesLoose(source, excluded);

  var key, i;

  if (Object.getOwnPropertySymbols) {
    var sourceSymbolKeys = Object.getOwnPropertySymbols(source);

    for (i = 0; i < sourceSymbolKeys.length; i++) {
      key = sourceSymbolKeys[i];
      if (excluded.indexOf(key) >= 0) continue;
      if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
      target[key] = source[key];
    }
  }

  return target;
}

const deepmerge = (x, y, _ref = {}) => {
  let rest = _objectWithoutProperties(_ref, ["arrayMerge"]);

  return merge(x, y, _objectSpread({}, rest, {
    arrayMerge: combineMerge
  }));
};

const emptyTarget = value => Array.isArray(value) ? [] : {};

const clone = (value, options) => merge(emptyTarget(value), value, options);

const combineMerge = (target, source, options) => {
  const destination = target.slice();
  source.forEach((e, i) => {
    if (typeof destination[i] === 'undefined') {
      const cloneRequested = options.clone !== false;
      const shouldClone = cloneRequested && options.isMergeableObject(e);
      destination[i] = shouldClone ? clone(e, options) : e;
    } else if (options.isMergeableObject(e)) {
      destination[i] = merge(target[i], e, options);
    } else if (target.indexOf(e) === -1) {
      destination.push(e);
    }
  });
  return destination;
};

const DDB = new AWS.DynamoDB({
  apiVersion: '2012-08-10',
  region: 'us-east-1'
});

const S3_SUFFIX = '.s3.amazonaws.com';
const ORIGIN_S3_DOTPATH = 'Records.0.cf.request.origin.s3';
const ttl = 300; // default TTL of 30 seconds

const cache = new Cache(ttl);

const rerouteOrigin = async (opts = {}, handler, next) => {
  const {
    context
  } = handler;
  const {
    request
  } = handler.event.Records[0].cf;
  const {
    origin
  } = request;
  const [host] = getHeaderValues(['host'], request.headers);
  const s3DomainName = origin && origin.s3 && origin.s3.domainName;
  const originBucket = s3DomainName && s3DomainName.replace(S3_SUFFIX, '');
  const tableSuffix = '-domainmap';
  const functionSuffix = '-originrequest';
  const defaults = {
    functionSuffix,
    tableSuffix,
    tableName: getTableFromFunctionName(context.functionName, functionSuffix, tableSuffix),
    cacheTtl: ttl
  };
  const options = deepmerge(defaults, opts);
  cache.setDefaultTtl(options.cacheTtl);
  log(`
    Raw Event:
    ${JSON.stringify(handler.event)}

    Middleware Options:
    ${JSON.stringify(options)}
    ---- Request ----
    URI: ${request.uri}
    Host: ${host}
    Origin: ${s3DomainName}
    `);

  try {
    const domainData = await getDomainData(options.tableName, host);
    log({
      domainData
    });
    handler.event = !!domainData ? deepmerge(handler.event, dotProp.set({}, ORIGIN_S3_DOTPATH, {
      region: domainData.region,
      domainName: domainData.origin
    })) : handler.event;
  } catch (err) {
    log('Throwing Error for main thread');
    throw err;
  }

  return;
};

var index = (opts => ({
  before: rerouteOrigin.bind(null, opts)
})); ///////////////////////
// Utils     //
///////////////////////

const getHeaderValues = (paramArr, headers) => paramArr.map(param => headers[param] && headers[param][0] && headers[param][0].value); // from:  us-east-1.marketing-stack-proxy-prod-viewerRequest
// to:    marketing-stack-proxy-prod-originmap


const getTableFromFunctionName = (functionName, functionSuffix, tableSuffix) => {
  const [rest, stackname] = functionName.match(`^us-east-1\.(.+)${functionSuffix}$`);
  return `${stackname}${tableSuffix}`;
};

const getDomainData = (table, host) => cache.get(`getDomainData_${host}`, () => DDB.getItem({
  Key: {
    Host: {
      S: host
    }
  },
  TableName: table
}).promise().then(data => {
  log(`
      getDomainData: 
      ${JSON.stringify(data)}`);
  return data.Item && data.Item.Origin && data.Item.Origin.S && {
    host: data.Item.Host.S,
    origin: data.Item.Origin.S,
    region: data.Item.Region.S
  };
}));

export default index;
//# sourceMappingURL=reroute-origin.esm.js.map
