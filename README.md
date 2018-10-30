wdio-sync
=========

![Build Status](https://travis-ci.org/webdriverio-boneyard/wdio-sync.svg?branch=master)

***

A WebdriverIO plugin. Helper module to run WebdriverIO commands synchronously. It overwrites global functions depending on the test framework (e.g. for Mocha `describe` and `it`) and uses Fibers to make commands of WebdriverIO using the wdio testrunner synchronous. This package is consumed by all wdio framework adapters.

# Development

All commands can be found in the package.json. The most important are:

Watch changes:

```sh
$ npm run watch
```

Run tests:

```sh
$ npm test

# run test with coverage report:
$ npm run test:cover
```

Build package:

```sh
$ npm build
```

# Contributing

Make sure all changes you apply are passing unit tests as well as all integration tests of the depending wdio framework adapters.
