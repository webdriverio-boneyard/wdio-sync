import sinon from 'sinon'
import {
    // wrapCommand,
    // wrapCommands,
    // runInFiberContext,
    executeHooksWithArgs,
    __RewireAPI__ as WDIOSyncRewire
} from '../'

describe('wdio-sync', () => {
    describe('executeHooksWithArgs', () => {
        let hook1, hook2, hook3

        before(() => {
            hook1 = sinon.spy()
            hook2 = sinon.spy()
            hook3 = sinon.spy()
        })

        it('should execute all hooks with same parameters', () => {
            executeHooksWithArgs([hook1, hook2, hook3], [1, 2, 3, 4])
            hook1.calledWith(1, 2, 3, 4).should.be.true()
            hook2.calledWith(1, 2, 3, 4).should.be.true()
            hook3.calledWith(1, 2, 3, 4).should.be.true()
        })

        it('should respect promises', async () => {
            let hook = () => {
                return new Promise((resolve) => {
                    setTimeout(() => resolve('done'), 1000)
                })
            }
            let start = new Date().getTime()
            let result = await executeHooksWithArgs([hook])
            let duration = new Date().getTime() - start
            duration.should.be.greaterThan(990)
            result[0].should.be.equal('done')
        })

        it('should allow func parameter', async () => {
            let hook = () => 'done'
            let result = await executeHooksWithArgs(hook)
            result[0].should.be.equal('done')
        })

        it('should reject if hook throws', async () => {
            let hookReject = () => new Promise((resolve, reject) => reject(new Error('buu')))
            let hookThrows = () => { throw new Error('buu') }
            try {
                await executeHooksWithArgs([hookReject, hookThrows])
                throw new Error('should never get thrown')
            } catch (e) {
                e.message.should.be.equal('buu')
            }
        })

        after(() => {
            /**
             * reset globals
             */
            WDIOSyncRewire.__Rewire__('commandIsRunning', false)
            WDIOSyncRewire.__Rewire__('forcePromises', false)
        })
    })

    describe('wdioSync', () => {
        let FiberMock = sinon.stub()
        let run = sinon.spy()
        FiberMock.returns({
            run: run
        })

        before(() => {
            WDIOSyncRewire.__Rewire__('Fiber', FiberMock)
        })

        it('should be registered globally', () => {
            (!!wdioSync).should.be.true()
        })

        it('should initiate Fiber context', (done) => {
            process.nextTick(wdioSync((a) => {
                FiberMock.called.should.be.true()
                run.called.should.be.true()
                a.should.be.equal('done')
                done()
            }).bind(null, 'done'))
            process.nextTick(() => FiberMock.callArg(0))
        })

        after(() => {
            WDIOSyncRewire.__ResetDependency__('Fiber')
        })
    })
})
