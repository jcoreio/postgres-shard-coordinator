/* eslint-env node, es2018 */
module.exports = {
  cjsBabelEnv: { forceAllTransforms: true },
  outputEsm: false,
  scripts: {
    postbuild:
      'mkdir -p dist/migrations && cp -vp src/migrations/*.sql dist/migrations',
  },
}
