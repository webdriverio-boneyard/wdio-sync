import { wrapCommands } from '../'
import Fiber from 'fibers'

const WebdriverIO = class {}
WebdriverIO.prototype = {
    getString: (a) => new Promise((r) => {
        setTimeout(() => r('foo'), 50)
    }),
    getInteger: (ms = 50) => new Promise((r) => {
        setTimeout(() => r(1), ms)
    }),
    getObject: (ms = 50) => new Promise((r) => {
        setTimeout(() => r({}), ms)
    }),
    getUndefined: (ms = 50) => new Promise((r) => {
        setTimeout(() => r(), ms)
    }),
    getNull: (ms = 50) => new Promise((r) => {
        setTimeout(() => r(null), ms)
    }),
    waitUntilSync: (fn) => new Promise((r) => {
        return wdioSync(fn, r)()
    })
}

const NOOP = () => {}

let instance

let run = (fn) => {
    return new Promise((resolve, reject) => {
        try {
            Fiber(() => {
                fn()
                resolve()
            }).run()
        } catch (e) {
            reject(e)
        }
    })
}

describe('wrapCommand', () => {
    before(() => {
        instance = new WebdriverIO()
        global.browser = { options: { sync: true } }
        wrapCommands(instance, NOOP, NOOP)
    })

    it('should return actual results', () => {
        return run(() => {
            instance.getString().should.be.equal('foo')
            instance.getInteger().should.be.equal(1)
            let result = typeof instance.getUndefined()
            result.should.be.equal('undefined')
            result = instance.getNull() === null
            result.should.be.true
        })
    })

    it('should not allow to chain strings, integer or falsy values', () => {
        return run(() => {
            let check = instance.getInteger().getObject === undefined
            check.should.be.true
            check = instance.getString().getObject === undefined
            check.should.be.true
            check = instance.getNull === null
            check.should.be.true
            check = instance.getUndefined === undefined
            check.should.be.true
        })
    })

    it('should propagate prototype for passed in function results', () => {
        return run(() => {
            instance.waitUntilSync(() => {
                instance.getString().should.be.equal('foo',
                    'waitUntil commands are not getting synchronised')
                instance.getObject().getString().should.be.equal('foo',
                    'waitUntil commands do not get enhanced prototype')
                return instance.getObject()
            }).getString().should.be.equal('foo',
                'waitUntil does not return enhanced prototype')
        })
    })

    after(() => {
        delete global.browser
    })
})
