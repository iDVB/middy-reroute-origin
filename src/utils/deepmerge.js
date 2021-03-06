import merge from 'deepmerge';

const deepmerge = (x, y, { arrayMerge, ...rest } = {}) =>
  merge(x, y, { ...rest, arrayMerge: combineMerge });

const all = (arr, { arrayMerge, ...rest } = {}) =>
  merge.all(arr, { ...rest, arrayMerge: combineMerge });

const emptyTarget = value => (Array.isArray(value) ? [] : {});
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

export default deepmerge;
export { all };
