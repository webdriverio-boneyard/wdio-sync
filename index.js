import Future from 'fibers/future'
import Fiber from 'fibers'
import assign from 'object.assign'

const SYNC_COMMANDS = ['domain', '_events', '_maxListeners', 'setMaxListeners', 'emit',
    'addListener', 'on', 'once', 'removeListener', 'removeAllListeners', 'listeners',
    'getMaxListeners', 'listenerCount', 'getPrototype']

const STACKTRACE_FILTER = /((wdio-sync\/)*(build\/index.js|node_modules\/fibers)|- - - - -)/g

let commandIsRunning = false
let forcePromises = false

let isAsync = function () {
    if (!global.browser || !global.browser.options) {
        return true
    }

    return global.browser.options.sync === false
}

let sanitizeErrorMessage = function (e) {
    let stack = e.stack.split(/\n/g)
    let errorMsg = stack.shift()
    let cwd = process.cwd()

    /**
     * filter out stack traces to wdio-sync and fibers
     * and transform absolute path to relative
     */
    stack = stack.filter((e) => !e.match(STACKTRACE_FILTER))
    stack = stack.map((e) => '    ' + e.replace(cwd + '/', '').trim())

    /**
     * this is just an assumption but works in most cases
     */
    let errorLine = stack.shift().trim()

    /**
     * correct error occurence
     */
    let lineToFix = stack[stack.length - 1]
    if (lineToFix.indexOf('index.js') > -1) {
        stack[stack.length - 1] = lineToFix.slice(0, lineToFix.indexOf('index.js')) + errorLine
    } else {
        stack.unshift('    ' + errorLine)
    }

    /**
     * add back error message
     */
    stack.unshift(errorMsg)

    return stack.join('\n')
}

/**
 * Helper method to execute a row of hooks with certain parameters.
 * It will return with a reject promise due to a design decision to not let hooks/service intefer the
 * actual test process.
 *
 * @param  {Function|Function[]} hooks  list of hooks
 * @param  {Object[]} args  list of parameter for hook functions
 * @return {Promise}  promise that gets resolved once all hooks finished running
 */
let executeHooksWithArgs = (hooks = [], args) => {
    /**
     * make sure hooks are an array of functions
     */
    if (typeof hooks === 'function') {
        hooks = [hooks]
    }

    /**
     * make sure args is an array since we are calling apply
     */
    if (!Array.isArray(args)) {
        args = [args]
    }

    hooks = hooks.map((hook) => new Promise((resolve) => {
        let _commandIsRunning = commandIsRunning
        let result

        const execHook = () => {
            commandIsRunning = true

            try {
                result = hook.apply(null, args)
            } catch (e) {
                console.error(e.stack)
                return resolve(e)
            }

            commandIsRunning = _commandIsRunning
            if (result && typeof result.then === 'function') {
                result.then(resolve, (e) => {
                    console.error(e.stack)
                    resolve(e)
                })
                return
            }

            resolve(result)
        }

        /**
         * no need for fiber wrap in async mode
         */
        if (isAsync()) {
            return execHook()
        }

        /**
         * after command hooks require additional Fiber environment
         */
        return Fiber(execHook).run()
    }))

    return Promise.all(hooks)
}

/**
 * global function to wrap callbacks into Fiber context
 * @param  {Function} fn  function to wrap around
 * @return {Function}     wrapped around function
 */
global.wdioSync = function (fn, done) {
    return function (...args) {
        return Fiber(() => {
            const result = fn.apply(this, args)

            if (typeof done === 'function') {
                done(result)
            }
        }).run()
    }
}

/**
 * wraps a function into a Fiber ready context to enable sync execution and hooks
 * @param  {Function}   fn             function to be executed
 * @param  {String}     commandName    name of that function
 * @param  {Function[]} beforeCommand  method to be executed before calling the actual function
 * @param  {Function[]} afterCommand   method to be executed after calling the actual function
 * @return {Function}   actual wrapped function
 */
let wrapCommand = function (fn, commandName, beforeCommand, afterCommand) {
    if (isAsync()) {
        /**
         * async command wrap
         */
        return function (...commandArgs) {
            return fn.apply(this, commandArgs)
        }
    }

    /**
     * sync command wrap
     */
    return function (...commandArgs) {
        let future = new Future()
        let futureFailed = false

        if (forcePromises) {
            return fn.apply(this, commandArgs)
        }

        /**
         * don't execute [before/after]Command hook if a command was executed
         * in these hooks (otherwise we will get into an endless loop)
         */
        if (commandIsRunning) {
            let commandPromise = fn.apply(this, commandArgs)

            /**
             * Try to execute with Fibers and fall back if can't.
             * This part is executed when we want to set a fiber context within a command (e.g. in waitUntil).
             */
            try {
                commandPromise.then((commandResult) => {
                    /**
                     * extend protoype of result so people can call browser.element(...).click()
                     */
                    future.return(applyPrototype.call(this, commandResult))
                }, future.throw.bind(future))
                return future.wait()
            } catch (e) {
                if (e.message === "Can't wait without a fiber") {
                    return commandPromise
                }
                throw e
            }
        }

        commandIsRunning = true
        let newInstance = this
        let commandResult, commandError
        executeHooksWithArgs(beforeCommand, [commandName, commandArgs]).then(() => {
            /**
             * actual function was already executed in desired catch block
             */
            if (futureFailed) {
                return
            }

            newInstance = fn.apply(this, commandArgs)
            return newInstance.then((result) => {
                commandResult = result
                return executeHooksWithArgs(afterCommand, [commandName, commandArgs, result])
            }, (e) => {
                commandError = e
                return executeHooksWithArgs(afterCommand, [commandName, commandArgs, null, e])
            }).then(() => {
                commandIsRunning = false

                if (commandError) {
                    return future.throw(commandError)
                }
                wrapCommands(newInstance, beforeCommand, afterCommand)
                return future.return(applyPrototype.call(newInstance, commandResult))
            })
        })

        /**
         * try to execute with Fibers and fall back if can't
         */
        try {
            return future.wait()
        } catch (e) {
            if (e.message === "Can't wait without a fiber") {
                futureFailed = true
                return fn.apply(this, commandArgs)
            }

            e.stack = sanitizeErrorMessage(e)
            throw e
        }
    }
}

/**
 * enhance result with instance prototype to enable command chaining
 * @param  {Object} result   command result
 * @return {Object}          command result with enhanced prototype
 */
let applyPrototype = function (result) {
    /**
     * don't overload result for none objects, arrays and buffer
     */
    if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.isBuffer(result)) {
        return result
    }

    let prototype = {}
    let hasExtendedPrototype = false
    for (let commandName of Object.keys(Object.getPrototypeOf(this))) {
        if (result[commandName] || SYNC_COMMANDS.indexOf(commandName) > -1) {
            continue
        }

        this.lastResult = result
        prototype[commandName] = { value: this[commandName].bind(this) }
        hasExtendedPrototype = true
    }

    if (hasExtendedPrototype) {
        let newResult = Object.create(result, prototype)

        /**
         * since status is a command we need to rename the property
         */
        if (typeof result.status !== 'undefined') {
            result._status = result.status
            delete result.status
        }

        result = assign(newResult, result)
    }

    return result
}

/**
 * wraps all WebdriverIO commands
 * @param  {Object}     instance       WebdriverIO client instance (browser)
 * @param  {Function[]} beforeCommand  before command hook
 * @param  {Function[]} afterCommand   after command hook
 */
let wrapCommands = function (instance, beforeCommand, afterCommand) {
    const addCommand = instance.addCommand

    /**
     * if instance is a multibrowser instance make sure to wrap commands
     * of its instances too
     */
    if (instance.isMultiremote) {
        instance.getInstances().forEach((browserName) => {
            wrapCommands(global[browserName], beforeCommand, afterCommand)
        })
    }

    Object.keys(Object.getPrototypeOf(instance)).forEach((commandName) => {
        if (SYNC_COMMANDS.indexOf(commandName) > -1) {
            return
        }

        let origFn = instance[commandName]
        instance[commandName] = wrapCommand.call(instance, origFn, commandName, beforeCommand, afterCommand)
    })

    /**
     * no need to overwrite addCommand in async mode
     */
    if (isAsync()) {
        return
    }

    /**
     * Adding a command within fiber context doesn't require a special routine
     * since everything runs sync. There is no need to promisify the command.
     */
    instance.addCommand = function (fnName, fn, forceOverwrite) {
        let commandGroup = instance.getPrototype()
        let commandName = fnName
        let namespace

        if (typeof fn === 'string') {
            namespace = arguments[0]
            fnName = arguments[1]
            fn = arguments[2]
            forceOverwrite = arguments[3]

            switch (typeof commandGroup[namespace]) {
            case 'function':
                throw new Error(`Command namespace "${namespace}" is used internally, and can't be overwritten!`)
            case 'undefined':
                commandGroup[namespace] = {}
                break
            }

            commandName = `${namespace}.${fnName}`
            commandGroup = commandGroup[namespace]
        }

        if (commandGroup[fnName] && !forceOverwrite) {
            throw new Error(`Command ${fnName} is already defined!`)
        }

        /**
         * If method name is async the user specifies that he wants to use bare promises to handle asynchronicity.
         * First use native addCommand in order to be able to chain with other native commands, then wrap new
         * command again to run it synchronous in the test method.
         * This will allow us to run async custom commands within sync custom commands in a sync way.
         */
        if (fn.name === 'async') {
            addCommand(fnName, function (...args) {
                const state = forcePromises
                forcePromises = true
                let res = fn.apply(instance, args)
                forcePromises = state
                return res
            }, forceOverwrite)
            commandGroup[fnName] = wrapCommand.call(commandGroup, commandGroup[fnName], fnName, beforeCommand, afterCommand)
            return
        }

        /**
         * for all other cases we internally return a promise that is
         * finished once the Fiber wrapped custom function has finished
         * #functionalProgrammingWTF!
         */
        commandGroup[fnName] = wrapCommand((...args) => new Promise((r) => {
            const state = forcePromises
            forcePromises = false
            wdioSync(fn, r).apply(instance, args)
            forcePromises = state
        }), commandName, beforeCommand, afterCommand)
    }
}

/**
 * execute test or hook synchronously
 * @param  {Function} fn         spec or hook method
 * @param  {Number}   repeatTest number of retries
 * @return {Promise}             that gets resolved once test/hook is done or was retried enough
 */
let executeSync = function (fn, repeatTest = 0, args = []) {
    /**
     * if a new hook gets executed we can assume that all commands should have finised
     * with exception of timeouts where `commandIsRunning` will never be reset but here
     */
    commandIsRunning = false

    return new Promise((resolve, reject) => {
        try {
            const res = fn.apply(this, args)
            resolve(res)
        } catch (e) {
            if (repeatTest) {
                return resolve(executeSync(fn, --repeatTest, args))
            }

            e.stack = e.stack.split('\n').filter((e) => !e.match(STACKTRACE_FILTER)).join('\n')
            reject(e)
        }
    })
}

/**
 * execute test or hook asynchronously
 * @param  {Function} fn         spec or hook method
 * @param  {Number}   repeatTest number of retries
 * @return {Promise}             that gets resolved once test/hook is done or was retried enough
 */
let executeAsync = function (fn, repeatTest = 0, args = []) {
    let result, error

    /**
     * if a new hook gets executed we can assume that all commands should have finised
     * with exception of timeouts where `commandIsRunning` will never be reset but here
     */
    commandIsRunning = false

    try {
        result = fn.apply(this, args)
    } catch (e) {
        error = e
    } finally {
        /**
         * handle errors that get thrown directly and are not cause by
         * rejected promises
         */
        if (error) {
            if (repeatTest) {
                return executeAsync(fn, --repeatTest, args)
            }
            return new Promise((_, reject) => reject(error))
        }

        /**
         * if we don't retry just return result
         */
        if (repeatTest === 0 || !result || typeof result.catch !== 'function') {
            return new Promise(resolve => resolve(result))
        }

        /**
         * handle promise response
         */
        return result.catch((e) => {
            if (repeatTest) {
                return executeAsync(fn, --repeatTest, args)
            }

            e.stack = e.stack.split('\n').filter((e) => !e.match(STACKTRACE_FILTER)).join('\n')
            return Promise.reject(e)
        })
    }
}

/**
 * fails properly depending on framework
 * @param  {Error}   e     error object
 * @param  {Function} done callback (in jasmine done.fail to end a failing test)
 */
let fail = function (e, done) {
    if (typeof done.fail === 'function') {
        return done.fail(e)
    }

    return done(e)
}

/**
 * runs a hook within fibers context (if function name is not async)
 * it also executes before/after hook hook
 *
 * @param  {Function} hookFn      function that was passed to the framework hook
 * @param  {Function} origFn      original framework hook function
 * @param  {Function} before      before hook hook
 * @param  {Function} after       after hook hook
 * @param  {Number}   repeatTest  number of retries if hook fails
 * @return {Function}             wrapped framework hook function
 */
let runHook = function (hookFn, origFn, before, after, repeatTest = 0) {
    return origFn(function (done) {
        // Print errors encountered in beforeHook and afterHook to console, but
        // don't propagate them to avoid failing the test. However, errors in
        // framework hook functions should fail the test, so propagate those.
        executeHooksWithArgs(before).catch((e) => {
            console.error(`Error in beforeHook: ${e.stack}`)
        }).then(() => {
            /**
             * user wants handle async command using promises, no need to wrap in fiber context
             */
            if (isAsync() || hookFn.name === 'async') {
                return executeAsync.call(this, hookFn, repeatTest)
            }

            return new Promise((resolve, reject) =>
                Fiber(() => executeSync.call(this, hookFn, repeatTest).then(() => resolve(), reject)).run()
            )
        }).then(() => {
            return executeHooksWithArgs(after).catch((e) => {
                console.error(`Error in afterHook: ${e.stack}`)
            })
        }).then(() => done(), (e) => fail(e, done))
    })
}

/**
 * runs a spec function (test function) within the fibers context
 * @param  {string}   specTitle   test description
 * @param  {Function} specFn      test function that got passed in from the user
 * @param  {Function} origFn      original framework test function
 * @param  {Number}   repeatTest  number of retries if test fails
 * @return {Function}             wrapped test function
 */
let runSpec = function (specTitle, specFn, origFn, repeatTest = 0) {
    /**
     * user wants handle async command using promises, no need to wrap in fiber context
     */
    if (isAsync() || specFn.name === 'async') {
        return origFn(specTitle, function (done) {
            return executeAsync.call(this, specFn, repeatTest)
               .then(() => done(), (e) => fail(e, done))
        })
    }

    return origFn(specTitle, function (resolve) {
        let reject = typeof resolve.fail === 'function' ? resolve.fail : resolve
        Fiber(() => executeSync.call(this, specFn, repeatTest).then(() => resolve(), reject)).run()
    })
}

/**
 * wraps hooks and test function of a framework within a fiber context
 * @param  {Function} origFn               original framework function
 * @param  {string[]} testInterfaceFnNames actual test functions for that framework
 * @return {Function}                      wrapped test/hook function
 */
let wrapTestFunction = function (fnName, origFn, testInterfaceFnNames, before, after) {
    return function (...specArguments) {
        /**
         * Variadic arguments:
         * [title, fn], [title], [fn]
         * [title, fn, retryCnt], [title, retryCnt], [fn, retryCnt]
         */
        let retryCnt = typeof specArguments[specArguments.length - 1] === 'number' ? specArguments.pop() : 0
        let specFn = typeof specArguments[0] === 'function' ? specArguments.shift()
            : (typeof specArguments[1] === 'function' ? specArguments.pop() : undefined)
        let specTitle = specArguments[0]

        if (testInterfaceFnNames.indexOf(fnName) > -1) {
            if (specFn) return runSpec(specTitle, specFn, origFn, retryCnt)

            /**
             * if specFn is undefined we are dealing with a pending function
             */
            return origFn(specTitle)
        }

        return runHook(specFn, origFn, before, after, retryCnt)
    }
}

/**
 * [runInFiberContext description]
 * @param  {[type]} testInterfaceFnNames  global command that runs specs
 * @param  {[type]} before               before hook hook
 * @param  {[type]} after                after hook hook
 * @param  {[type]} fnName               test interface command to wrap
 */
let runInFiberContext = function (testInterfaceFnNames, before, after, fnName) {
    let origFn = global[fnName]
    global[fnName] = wrapTestFunction(fnName, origFn, testInterfaceFnNames, before, after)

    /**
     * support it.skip for the Mocha framework
     */
    if (typeof origFn.skip === 'function') {
        global[fnName].skip = origFn.skip
    }

    /**
     * wrap it.only for the Mocha framework
     */
    if (typeof origFn.only === 'function') {
        let origOnlyFn = origFn.only
        global[fnName].only = wrapTestFunction(fnName + '.only', origOnlyFn, testInterfaceFnNames, before, after)
    }
}

export { wrapCommand, wrapCommands, runInFiberContext, executeHooksWithArgs, executeSync, executeAsync }
