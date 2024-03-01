/* eslint-env node, es2018 */

const path = require('path')
const execa = require('@jcoreio/toolchain/util/execa.cjs')
const defaultenv = require('defaultenv')

module.exports = {
  cjsBabelEnv: { forceAllTransforms: true },
  outputEsm: false,
  scripts: {
    pretest: {
      run: async () => {
        defaultenv([path.resolve('env/local.js')])
        if (!process.env.CI) await execa('docker', ['compose', 'up', '-d'])
      },
      description: 'runs before test',
    },
    postbuild:
      'mkdir -p dist/migrations && cp -vp src/migrations/*.sql dist/migrations',
  },
}
