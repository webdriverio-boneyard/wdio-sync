import Future from 'fibers/future'
import Fiber from 'fibers'

let fiberify = function(origFn) {
    return function(...commandArgs) {
        let future = new Future()
        let result = origFn.apply(this, commandArgs)

        result.then(::future.return, ::future.throw)
        return future.wait()
    }
}

let wrapCommand = function(instance, implementedCommands) {
    Object.keys(implementedCommands).forEach((commandName) => {
        let origFn = instance[commandName]
        instance[`${commandName}Async`] = origFn
        instance[commandName] = fiberify(origFn)
    })

    /**
     * Adding a command within fiber context doesn't require a special routine
     * since everything runs sync. There is no need to promisify the command.
     */
    instance.addCommand = function(fnName, fn, forceOverwrite) {
        if(instance[fnName] && !forceOverwrite) {
            throw new Error(`Command ${fnName} is already defined!`)
        }
        instance[fnName] = fn
    }
}

let runInFiberContext = function (interface, ui, fnName) {
    let origFn = global[fnName]
    let interfaceTestFnName = interface[2]

    var runSpec = function(specTitle, specFn) {
        return origFn.call(null, specTitle, function(done) {
            Fiber(() => {
                specFn()
                done()
            }).run()
        })
    }

    var runHook = function(specFn, specTimeout) {
        return origFn((done) => {
            Fiber(() => {
                specFn()
                done()
            }).run()
        }, specTimeout)
    }

    global[fnName] = function(...specArguments) {
        var specFn = typeof specArguments[0] === 'function' ? specArguments.shift() : specArguments.pop(),
            specTitle = specArguments[0]

        /**
         * if specFn is undefined we are dealing with a pending function
         */
        if(fnName === interfaceTestFnName && arguments.length === 1) {
            return origFn(specTitle)
        }

        if(fnName === interfaceTestFnName) {
            return runSpec(specTitle, specFn)
        }

        return runHook(specFn)
    }

    if(fnName === interfaceTestFnName) {
        global[fnName].skip = origFn.skip
        global[fnName].only = origFn.only
    }
}

exports {
    wrapCommand: wrapCommand,
    runInFiberContext: runInFiberContext
}
