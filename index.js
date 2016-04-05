import Future from 'fibers/future'
import Fiber from 'fibers'
import assign from 'object.assign'

const SYNC_COMMANDS = ['domain', '_events', '_maxListeners', 'setMaxListeners', 'emit',
    'addListener', 'on', 'once', 'removeListener', 'removeAllListeners', 'listeners',
    'getMaxListeners', 'listenerCount']

let commandIsRunning = false
let forcePromises = false

let isAsync = function () {
    if (!global.browser || !global.browser.options) {
        return false
    }

    return global.browser.options.sync === false
}

/**
 * helper method to execute a row of hooks with certain parameters
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

        /**
         * no need for fiber wrap in async mode
         */
        if (isAsync()) {
            commandIsRunning = true
            let result = resolve(hook.apply(null, args))
            commandIsRunning = _commandIsRunning
            return result
        }

        try {
            /**
             * after command hooks require additional Fiber environment
             */
            return Fiber(() => {
                commandIsRunning = true
                resolve(hook.apply(null, args))
                commandIsRunning = _commandIsRunning
            }).run()
        } catch (e) {
            console.error(e.stack)
        }

        resolve()
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
             * try to execute with Fibers and fall back if can't
             */
            try {
                commandPromise.then(future.return.bind(future), future.throw.bind(future))
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
        new Promise((r) => r(executeHooksWithArgs(beforeCommand, [commandName, commandArgs])))
            .then(() => {
                /**
                 * actual function was already executed in desired catch block
                 */
                if (futureFailed) {
                    return
                }

                newInstance = fn.apply(this, commandArgs)
                return newInstance
            })
            .then(
                (result) => {
                    commandResult = result
                    return executeHooksWithArgs(afterCommand, [commandName, commandArgs, result])
                },
                (e) => {
                    commandError = e
                    return executeHooksWithArgs(afterCommand, [commandName, commandArgs, null, e])
                }
            )
            .then(() => {
                commandIsRunning = false

                if (commandError) {
                    return future.throw(commandError)
                }
                wrapCommands(newInstance, beforeCommand, afterCommand)
                return future.return(applyPrototype.call(newInstance, commandResult))
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
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
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
         * if method name is async the user specifies that he wants to
         * use bare promises to handle asynchronicity
         */
        if (fn.name === 'async') {
            commandGroup[fnName] = wrapCommand((...args) => {
                forcePromises = true
                let res = fn.apply(instance, args)
                forcePromises = false
                return res
            }, commandName, beforeCommand, afterCommand)
            return
        }

        /**
         * for all other cases we internally return a promise that is
         * finished once the Fiber wrapped custom function has finished
         * #functionalProgrammingWTF!
         */
        commandGroup[fnName] = wrapCommand((...args) => new Promise((r) => {
            wdioSync(fn, r).apply(instance, args)
        }), commandName, beforeCommand, afterCommand)
    }
}

/**
 * runs a hook within fibers context (if function name is not async)
 * it also executes before/after hook hook
 *
 * @param  {Function} hookFn function that was passed to the framework hook
 * @param  {Function} origFn original framework hook function
 * @return {Function}        wrapped framework hook function
 */
let runHook = function (hookFn, origFn, before, after) {
    /**
     * user wants handle async command using promises, no need to wrap in fiber context
     */
    if (isAsync() || hookFn.name === 'async') {
        return origFn(function (done) {
            executeHooksWithArgs(before).catch((e) => {
                console.error(`Error in beforeHook: [${e}]`)
            }).then(() => {
                return hookFn.call(this)
            }).then(() => {
                return executeHooksWithArgs(after)
                .catch((e) => {
                    console.error(`Error in afterHook: [${e}]`)
                })
            }).then(() => done(), done)
        })
    }

    return origFn(function (done) {
        // Print errors encountered in beforeHook and afterHook to console, but
        // don't propagate them to avoid failing the test. However, errors in
        // framework hook functions should fail the test, so propagate those.
        executeHooksWithArgs(before)
            .catch((e) => {
                console.error(`Error in beforeHook: [${e}]`)
            })
            .then(() => new Promise((resolve, reject) => {
                return Fiber(() => {
                    try {
                        hookFn.call(this)
                    } catch (e) {
                        reject(e)
                    }
                    resolve()
                }).run()
            }))
            .then(() => {
                return executeHooksWithArgs(after)
                .catch((e) => {
                    console.error(`Error in afterHook: [${e}]`)
                })
            })
            .then(() => done(), done)
    })
}

/**
 * runs a spec function (test function) within the fibers context
 * @param  {string}   specTitle  test description
 * @param  {Function} specFn     test function that got passed in from the user
 * @param  {Function} origFn     original framework test function
 * @return {Function}            wrapped test function
 */
let runSpec = function (specTitle, specFn, origFn) {
    /**
     * user wants handle async command using promises, no need to wrap in fiber context
     */
    if (isAsync() || specFn.name === 'async') {
        return origFn.call(this, specTitle, specFn)
    }

    return origFn(specTitle, function (done) {
        Fiber(() => {
            specFn.call(this)
            done()
        }).run()
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
         * Variadic arguments: [title, fn], [title], [fn]
         */
        let specFn = typeof specArguments[0] === 'function' ? specArguments.shift()
            : (typeof specArguments[1] === 'function' ? specArguments.pop() : undefined)
        let specTitle = specArguments[0]

        if (testInterfaceFnNames.indexOf(fnName) > -1) {
            if (specFn) return runSpec(specTitle, specFn, origFn)

            /**
             * if specFn is undefined we are dealing with a pending function
             */
            return origFn(specTitle)
        }

        return runHook(specFn, origFn, before, after)
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

export { wrapCommand, wrapCommands, runInFiberContext, executeHooksWithArgs }
