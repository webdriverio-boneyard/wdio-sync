import Future from 'fibers/future'
import Fiber from 'fibers'

const SYNC_COMMANDS = ['domain', '_events', '_maxListeners', 'setMaxListeners', 'emit',
    'addListener', 'on', 'once', 'removeListener', 'removeAllListeners', 'listeners']
const NOOP = function () {}

let wrapCommand = function (instance, hooks) {

    Object.keys(Object.getPrototypeOf(instance)).forEach((commandName) => {
        if (SYNC_COMMANDS.indexOf(commandName) > -1) {
            return
        }

        let origFn = instance[commandName]
        instance[commandName] = function (...commandArgs) {
            let future = new Future()

            hooks.beforeCommand({command: commandName})
            let result = origFn.apply(this, commandArgs)
            hooks.afterCommand({command: commandName})

            result.then(future.return.bind(future), future.throw.bind(future))
            return future.wait()
        }
    })

    /**
     * Adding a command within fiber context doesn't require a special routine
     * since everything runs sync. There is no need to promisify the command.
     */
    instance.addCommand = function (fnName, fn, forceOverwrite) {
        let commandGroup = instance

        if (typeof fn === 'string') {
            const namespace = arguments[0]
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

            commandGroup = commandGroup[namespace]
        }

        if (commandGroup[fnName] && !forceOverwrite) {
            throw new Error(`Command ${fnName} is already defined!`)
        }
        commandGroup[fnName] = function () {
            const name = namespace ? `${namespace}.${fnName}` : fnName
            instance.commandList.push({
                name: name,
                args: arguments
            })
            hooks.beforeCommand({command: name})
            fn.apply(instance, arguments)
            hooks.afterCommand({command: name})
        }
    }
}

let runInFiberContext = function (testInterface, ui, hooks, fnName) {
    let origFn = global[fnName]
    let testInterfaceFnName = testInterface[ui][2]

    let runSpec = function (specTitle, specFn) {
        return origFn(specTitle, function (done) {
            Fiber(() => {
                specFn.call(this)
                done()
            }).run()
        })
    }

    let runHook = function (specTitle, specFn) {
        return origFn(specTitle, function (done) {
            Fiber(() => {
                // console.log('actual mocha call running', specTitle)
                hooks.beforeHook()
                specFn.call(this)
                hooks.afterHook()
                done()
            }).run()
        })
    }

    global[fnName] = function (...specArguments) {
        let specFn = typeof specArguments[0] === 'function' ? specArguments.shift() : specArguments.pop()
        let specTitle = specArguments[0]

        /**
         * if specFn is undefined we are dealing with a pending function
         */
        if (fnName === testInterfaceFnName && arguments.length === 1) {
            return origFn(specTitle)
        }

        if (fnName === testInterfaceFnName) {
            return runSpec(specTitle, specFn)
        }

        return runHook(specTitle, specFn)
    }

    if (fnName === testInterfaceFnName) {
        global[fnName].skip = origFn.skip
        global[fnName].only = origFn.only
    }
}

let runHook = function (hookFn, cb = NOOP) {
    return new Promise((resolve, reject) => {
        Fiber(() => {
            try {
                hookFn()
                cb()
                resolve()
            } catch (e) {
                reject(e)
            }
        }).run()
    })
}

let wrapFn = function (origFn) {
    return function (...commandArgs) {
        let future = new Future()
        let result = origFn.apply(this, commandArgs)

        result.then(future.return.bind(future), future.throw.bind(future))
        return future.wait()
    }
}

export { wrapCommand, runInFiberContext, runHook, wrapFn }
