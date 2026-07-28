/// <reference path="../../../node_modules/node-pty/node-pty.d.ts" />

// The dependency is installed via the npm alias "node-pty" -> "@lydell/node-pty",
// whose bundled declaration file only declares the ambient module
// '@lydell/node-pty'. Bridge the aliased specifier onto those upstream types.
declare module 'node-pty' {
  export * from '@lydell/node-pty'
}
