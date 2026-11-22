import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQueueWorker } from '../lib/queue-worker.mjs'
import { commandItem, withQueueWorld } from './git-helpers.mjs'

test('worker: команду выполняет ровно одно устройство', async () => {
  await withQueueWorld(async ({ make }) => {
    const a = make({ id: 'dev-a', name: 'A' })
    const b = make({ id: 'dev-b', name: 'B' })
    await a.enqueueCommand(commandItem(1001, '/help'))
    const executed = []
    const workerA = createQueueWorker({
      queue: a,
      execute: async command => {
        executed.push(`a:${command.commandId}`)
        return { status: 'ok', output: 'ответ', delivered: true }
      },
    })
    const workerB = createQueueWorker({
      queue: b,
      execute: async command => {
        executed.push(`b:${command.commandId}`)
        return { status: 'ok', output: 'ответ', delivered: true }
      },
    })
    const first = await workerA.runNow()
    assert.equal(first.ok, true)
    assert.equal(executed.length, 1)
    const second = await workerB.runNow()
    assert.equal(second.ok, true)
    assert.equal(executed.length, 1, 'второй worker не выполняет готовую команду')
    await b.sync()
    const snapshot = await b.snapshot()
    assert.deepEqual(snapshot.counts, { total: 1, new: 0, inProgress: 0, done: 1 })
    assert.equal(snapshot.items[0].result.output, 'ответ')
  })
})

test('worker: без отправки execute ответ уходит через send один раз', async () => {
  await withQueueWorld(async ({ make }) => {
    const queue = make({ id: 'dev-a', name: 'A' })
    await queue.enqueueCommand(commandItem(1101, '/help'))
    const sent = []
    const worker = createQueueWorker({
      queue,
      execute: async () => ({ status: 'ok', output: '✅ Принято', text: '✅ Принято', chatId: '555', chatTitle: 'Иван' }),
      send: async payload => {
        sent.push(payload)
      },
    })
    await worker.runNow()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].chatId, '555')
    await worker.runNow()
    assert.equal(sent.length, 1, 'повторного ответа нет')
  })
})

test('worker: ошибка execute пишется в result и done, повтора нет', async () => {
  await withQueueWorld(async ({ make }) => {
    const queue = make({ id: 'dev-a', name: 'A' })
    await queue.enqueueCommand(commandItem(1201, '/ask'))
    let calls = 0
    const worker = createQueueWorker({
      queue,
      execute: async () => {
        calls += 1
        throw new Error('DSH упал')
      },
    })
    await worker.runNow()
    assert.equal(calls, 1)
    const snapshot = await queue.snapshot()
    assert.deepEqual(snapshot.counts, { total: 1, new: 0, inProgress: 0, done: 1 })
    assert.equal(snapshot.items[0].result.status, 'error')
    assert.match(snapshot.items[0].result.output, /DSH упал/)
    await worker.runNow()
    assert.equal(calls, 1)
  })
})

test('worker: статус публикуется и виден другому устройству', async () => {
  await withQueueWorld(async ({ make }) => {
    const a = make({ id: 'dev-a', name: 'A' })
    const b = make({ id: 'dev-b', name: 'B' })
    const worker = createQueueWorker({ queue: a, execute: async () => ({ status: 'ok', output: '', delivered: true }), isListener: () => true })
    await worker.runNow()
    const status = worker.status()
    assert.equal(status.running, false)
    assert.ok(status.lastSyncAt > 0)
    await b.sync()
    const statuses = await b.statuses()
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].listener, true)
  })
})

test('worker: два параллельных прохода не выполняют команду дважды', async () => {
  await withQueueWorld(async ({ make }) => {
    const a = make({ id: 'dev-a', name: 'A' })
    const b = make({ id: 'dev-b', name: 'B' })
    await a.enqueueCommand(commandItem(1301, '/help'))
    let executions = 0
    const execute = async () => {
      executions += 1
      return { status: 'ok', output: 'ok', delivered: true }
    }
    const workerA = createQueueWorker({ queue: a, execute })
    const workerB = createQueueWorker({ queue: b, execute })
    await Promise.all([workerA.runNow(), workerB.runNow()])
    assert.ok(executions <= 1)
    // A second pass settles the command if both first passes lost the race.
    await workerA.runNow()
    await workerB.runNow()
    assert.ok(executions <= 1)
    await a.sync()
    assert.equal((await a.snapshot()).counts.done, 1)
  })
})

test('worker: start/stop крутит цикл и снимается', async () => {
  await withQueueWorld(async ({ make }) => {
    const queue = make({ id: 'dev-a', name: 'A' })
    const worker = createQueueWorker({ queue, intervalMs: 20, execute: async () => ({ status: 'ok', output: '', delivered: true }) })
    worker.start()
    await new Promise(resolve => setTimeout(resolve, 80))
    worker.stop()
    for (let attempt = 0; attempt < 40 && worker.status().busy; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(worker.status().running, false)
    assert.ok(worker.status().ticks >= 1)
  })
})
