// Compiles the TypeScript sources for Jest, keeping source maps for coverage.
const ts = require('typescript');
const { compilerOptions } = require('../tsconfig.json');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText, sourceMapText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        ...ts.convertCompilerOptionsFromJson(compilerOptions).options,
        module: ts.ModuleKind.ESNext,
        declaration: false,
        declarationMap: false,
        sourceMap: true,
      },
    });
    return { code: outputText.replace(/\n\/\/# sourceMappingURL=.*$/, ''), map: sourceMapText };
  },
};
