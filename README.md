wdio-sync
=========

[![Build Status](https://travis-ci.org/webdriverio/wdio-sync.svg?branch=master)](https://travis-ci.org/webdriverio/wdio-sync) [![Code Climate](https://codeclimate.com/github/webdriverio/wdio-sync/badges/gpa.svg)](https://codeclimate.com/github/webdriverio/wdio-sync) [![Test Coverage](https://codeclimate.com/github/webdriverio/wdio-sync/badges/coverage.svg)](https://codeclimate.com/github/webdriverio/wdio-sync/coverage) [![Dependency Status](https://www.versioneye.com/user/projects/58ba933101b5b7004a7b5b8d/badge.svg?style=flat-square)](https://www.versioneye.com/user/projects/58ba933101b5b7004a7b5b8d)

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
