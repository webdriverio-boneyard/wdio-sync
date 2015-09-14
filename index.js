import Future from 'fibers/future'
import Fiber from 'fibers'

let fiberify = function (origFn) {
    return function (...commandArgs) {
        let future = new Future()
        let result = origFn.apply(this, commandArgs)

        result.then(future.return.bind(future), future.throw.bind(future))
        return future.wait()
    }
}

let wrapCommand = function (instance, implementedCommands) {
    Object.keys(implementedCommands).forEach((commandName) => {
        let origFn = instance[commandName]
        instance[`${commandName}Async`] = origFn
        instance[commandName] = fiberify(origFn)
    })

    /**
     * Adding a command within fiber context doesn't require a special routine
     * since everything runs sync. There is no need to promisify the command.
     */
    instance.addCommand = function (fnName, fn, forceOverwrite) {
        if (instance[fnName] && !forceOverwrite) {
            throw new Error(`Command ${fnName} is already defined!`)
        }
        instance[fnName] = fn
    }
}

let runInFiberContext = function (testInterface, ui, fnName) {
    let origFn = global[fnName]
    let testInterfaceFnName = testInterface[2]

    let runSpec = function (specTitle, specFn) {
        return origFn(specTitle, function (done) {
            Fiber(() => {
                specFn()
                done()
            }).run()
        })
    }

    let runHook = function (specFn, specTimeout) {
        return origFn((done) => {
            Fiber(() => {
                specFn()
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

export { wrapCommand, runInFiberContext }
