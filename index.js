import Future from 'fibers/future'
import Fiber from 'fibers'

const SYNC_COMMANDS = ['domain', '_events', '_maxListeners', 'setMaxListeners', 'emit',
    'addListener', 'on', 'once', 'removeListener', 'removeAllListeners', 'listeners']

let commandIsRunning = false
let forcePromises = false

/**
 * helper method to execute a row of hooks with certain parameters
 * @param  {Function|Function[]} hooks  list of hooks
 * @param  {Object[]} args  list of parameter for hook functions
 * @return {Promise}  promise that gets resolved once all hooks finished running
 */
let executeHooksWithArgs = (hooks, args) => {
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
 * @param  {[Function[]]} commandHooks  hooks to run before/after commands, on command exceptions, etc.
 * @return {Function}   actual wrapped function
 */
let wrapCommand = function (fn, commandName, commandHooks) {
    return function (...commandArgs) {
        let future = new Future()
        let futureFailed = false

        if (forcePromises) {
            return fn.apply(this, commandArgs)
        }

        /**
         * don't execute [before/after]Command hook if a command was executed
         * in these hooks
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
                executeHooksWithArgs(commandHooks.onCommandException, [commandName, commandArgs, null, e])
                if (typeof e.wdioExceptionHandler === 'function') {
                    return e.wdioExceptionHandler()
                }
                throw e
            }
        }

        commandIsRunning = true
        let commandResult, commandError
        new Promise((r) => r(executeHooksWithArgs(commandHooks.beforeCommand, [commandName, commandArgs])))
            .then(() => {
                /**
                 * actual function was already executed in desired catch block
                 */
                if (futureFailed) {
                    return
                }

                return fn.apply(this, commandArgs)
            })
            .then(
                (result) => {
                    commandResult = result
                    return executeHooksWithArgs(commandHooks.afterCommand, [commandName, commandArgs, result])
                },
                (e) => {
                    commandError = e
                    return executeHooksWithArgs(commandHooks.afterCommand, [commandName, commandArgs, null, e])
                }
            )
            .then(() => {
                commandIsRunning = false

                if (commandError) {
                    return future.throw(commandError)
                }
                return future.return(commandResult)
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
            if (typeof e.wdioExceptionHandler === 'function') {
                return e.wdioExceptionHandler()
            }
            throw e
        }
    }
}

/**
 * wraps all WebdriverIO commands
 * @param  {Object}     instance       WebdriverIO client instance (browser)
 * @param  {[Function[]]} commandHooks  hooks to run before/after commands, on command exceptions, etc.
 */
let wrapCommands = function (instance, commandHooks) {
    Object.keys(Object.getPrototypeOf(instance)).forEach((commandName) => {
        if (SYNC_COMMANDS.indexOf(commandName) > -1) {
            return
        }

        let origFn = instance[commandName]
        instance[commandName] = wrapCommand(origFn, commandName, commandHooks)
    })

    /**
     * Adding a command within fiber context doesn't require a special routine
     * since everything runs sync. There is no need to promisify the command.
     */
    instance.addCommand = function (fnName, fn, forceOverwrite) {
        let commandGroup = instance
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
            }, commandName, commandHooks)
            return
        }

        /**
         * for all other cases we internally return a promise that is
         * finished once the Fiber wrapped custom function has finished
         * #functionalProgrammingWTF!
         */
        commandGroup[fnName] = wrapCommand((...args) => new Promise((r) => {
            wdioSync(fn, r).apply(instance, args)
        }), commandName, commandHooks)
    }
}

/**
 * [runInFiberContext description]
 * @param  {[type]} testInterfaceFnName  global command that runs specs
 * @param  {[type]} before               before hook hook
 * @param  {[type]} after                after hook hook
 * @param  {[type]} fnName               test interface command to wrap
 */
let runInFiberContext = function (testInterfaceFnName, before, after, fnName) {
    let origFn = global[fnName]

    let runSpec = function (specTitle, specFn) {
        return origFn(specTitle, function (done) {
            Fiber(() => {
                specFn.call(this)
                done()
            }).run()
        })
    }

    let runHook = function (hookFn) {
        return origFn(function (done) {
            Fiber(() => {
                executeHooksWithArgs(before)
                    .then(() => hookFn.call(this))
                    .then(() => executeHooksWithArgs(after))
                    .then(() => done(), () => done())
            }).run()
        })
    }

    global[fnName] = function (...specArguments) {
        /**
         * Variadic arguments: [title, fn], [title], [fn]
         */
        let specFn = typeof specArguments[0] === 'function' ? specArguments.shift()
            : (typeof specArguments[1] === 'function' ? specArguments.pop() : undefined)
        let specTitle = specArguments[0]

        if (fnName === testInterfaceFnName) {
            if (specFn) return runSpec(specTitle, specFn)

            /**
             * if specFn is undefined we are dealing with a pending function
             */
            return origFn(specTitle)
        }

        return runHook(specFn)
    }

    if (fnName === testInterfaceFnName) {
        global[fnName].skip = origFn.skip
        global[fnName].only = origFn.only
    }
}

export { wrapCommand, wrapCommands, runInFiberContext, executeHooksWithArgs }
