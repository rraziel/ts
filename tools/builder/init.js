const fs = require('fs')
const path = require('path')
const os = require('os')

exports.init = () => {
  const helperPkgJson = require('./package.json')

  const cwd = process.cwd()
  const pkgJsonPath = path.join(cwd, 'package.json')
  const oldContent = fs.existsSync(pkgJsonPath) ? fs.readFileSync(pkgJsonPath).toString() : '{}'
  const pkgJson = JSON.parse(oldContent)

  pkgJson.name = pkgJson.name || path.basename(cwd)
  pkgJson.version = pkgJson.version || '0.0.1'
  pkgJson.main = pkgJson.main || 'dist/index.js'
  pkgJson.types = pkgJson.types || 'dist/index.d.ts'
  pkgJson.scripts = pkgJson.scripts || {}
  pkgJson.scripts.build = 'run heft test --clean'
  pkgJson.scripts.compile = 'run tsc -p .'
  pkgJson.scripts.lint = 'run eslint --cache .'
  pkgJson.scripts.test = 'run jest'
  pkgJson.devDependencies = pkgJson.devDependencies || {}
  pkgJson.devDependencies[helperPkgJson.name] = pkgJson.devDependencies[helperPkgJson.name] || helperPkgJson.version

  const stringify = obj => JSON.stringify(obj, null, 2) + os.EOL
  const newContent = stringify(pkgJson)
  if (newContent !== oldContent) {
    fs.writeFileSync(pkgJsonPath, newContent, 'utf8')
  }

  const eslintrcPath = path.join(process.cwd(), '.eslintrc.js')
  fs.writeFileSync(eslintrcPath, `module.exports = require('${helperPkgJson.name}/.eslintrc')${os.EOL}`, 'utf8')

  const jestConfigPath = path.join(cwd, 'config/jest.config.json')
  fs.mkdirSync(path.dirname(jestConfigPath), {recursive: true})
  fs.writeFileSync(
    jestConfigPath,
    JSON.stringify({extends: `./node_modules/${helperPkgJson.name}/jest-shared.json`}, null, 2) + os.EOL,
    'utf8'
  )

  const oldJestConfigPath = path.join(cwd, 'jest.config.js')
  fs.unlinkSync(oldJestConfigPath)

  const tsconfigPath = path.join(cwd, 'tsconfig.json')
  fs.writeFileSync(
    tsconfigPath,
    stringify({
      extends: './node_modules/@mmkal/builder/tsconfig.json',
      compilerOptions: {
        rootDir: 'src',
        outDir: 'dist',
        tsBuildInfoFile: 'dist/buildinfo.json',
        typeRoots: ['node_modules/@mmkal/builder/node_modules/@types'],
      },
      exclude: ['node_modules', 'dist'],
    }),
    'utf8'
  )

  const npmIgnorePath = path.join(cwd, '.npmignore')
  if (!fs.existsSync(npmIgnorePath)) {
    const content = `
      node_modules
      **/__tests__
      dist/buildinfo.json
      CHANGELOG.md
    `
    fs.writeFileSync(npmIgnorePath, content.trim().replace(/\r?\n +/g, os.EOL))
  }

  const readmePath = path.join(cwd, 'readme.md')
  if (!fs.existsSync(readmePath) && !fs.existsSync(path.join(cwd, 'README.md'))) {
    fs.writeFileSync(readmePath, `# ${pkgJson.name}${os.EOL}${os.EOL}${pkgJson.description || ''}`.trim(), 'utf8')
  }
}

if (require.main === module) {
  exports.init()
}
