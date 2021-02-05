'use strict'

module.exports = function (source, map) {
  const loaderContext = this
  const { resourcePath } = loaderContext
  if (!/vue/.test(resourcePath) || !/veq=true/.test(resourcePath)) return loaderContext.callback(null, source, map)
}
