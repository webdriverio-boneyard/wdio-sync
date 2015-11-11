import Future from 'fibers/future'
import Fiber from 'fibers'

const SYNC_COMMANDS = ['domain', '_events', '_maxListeners', 'setMaxListeners', 'emit',
    'addListener', 'on', 'once', 'removeListener', 'removeAllListeners', 'listeners']

let fiberify = function (origFn) {
    return function (...commandArgs) {
        let future = new Future()
        let result = origFn.apply(this, commandArgs)

        result.then(future.return.bind(future), future.throw.bind(future))
        return future.wait()
    }
}

let wrapCommand = function (instance) {
    Object.keys(Object.getPrototypeOf(instance)).forEach((commandName) => {
        if (SYNC_COMMANDS.indexOf(commandName) > -1) {
            return
        }

        let origFn = instance[commandName]
        instance[commandName] = fiberify(origFn)
    })

    /**
     * Adding a command within fiber context doesn't require a special routine
     * since everything runs sync. There is no need to promisify the command.
     */
    instance.addCommand = function (fnName, fn, forceOverwrite) {
        let commandGroup = instance
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

            commandGroup = commandGroup[namespace]
        }

        if (commandGroup[fnName] && !forceOverwrite) {
            throw new Error(`Command ${fnName} is already defined!`)
        }
        commandGroup[fnName] = function() {
            const name = namespace ? `${namespace}.${fnName}` : fnName
            instance.commandList.push({
                name: name,
                args: arguments
            })
            fn.apply(instance, arguments);
        }
    }
}

let runInFiberContext = function (testInterface, ui, fnName) {
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

    let runHook = function (specFn, specTimeout) {
        return origFn(function (done) {
            Fiber(() => {
                specFn.call(this)
                done()
            }).run()
        }, specTimeout)
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

        return runHook(specFn)
    }

    if (fnName === testInterfaceFnName) {
        global[fnName].skip = origFn.skip
        global[fnName].only = origFn.only
    }
}

let runHook = function (hookFn) {
    return new Promise((resolve, reject) => {
        Fiber(() => {
            try {
                hookFn()
                resolve()
            } catch (e) {
                reject(e)
            }
        }).run()
    })
}

export { wrapCommand, runInFiberContext, runHook }
