import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { commandIdFor, pickClaimWinner } from '../lib/queue.mjs'
import { botIdFromToken } from '../lib/device.mjs'
import { commandItem, withQueueWorld } from './git-helpers.mjs'

test('botIdFromToken и commandIdFor: стабильные id без токена', () => {
  assert.equal(botIdFromToken('123456789:AAHfakeTOKENvalue_0123456789abcdef'), '123456789')
  assert.equal(botIdFromToken(''), '')
  assert.equal(botIdFromToken('не токен'), '')
  assert.equal(commandIdFor('123456789', 42), '123456789-42')
  assert.equal(commandIdFor('', 42), 'bot-42')
  assert.equal(commandIdFor('123456789', 42), commandIdFor('123456789', 42))
})

test('pickClaimWinner: попытка, затем время, затем устройство', () => {
  const claims = [
    { deviceId: 'b', attempt: 1, claimedAt: 200 },
    { deviceId: 'a', attempt: 1, claimedAt: 100 },
    { deviceId: 'c', attempt: 2, claimedAt: 50 },
  ]
  assert.equal(pickClaimWinner(claims).deviceId, 'a')
  assert.equal(pickClaimWinner([{ deviceId: 'b', attempt: 1, claimedAt: 100 }, { deviceId: 'a', attempt: 1, claimedAt: 100 }]).deviceId, 'a')
  assert.equal(pickClaimWinner([]), undefined)
})

test('enqueue: повторный updateId не создаёт вторую команду', async () => {
  await withQueueWorld(async ({ make }) => {
    const queue = make({ id: 'dev-a', name: 'A' })
    const first = await queue.enqueueCommand(commandItem(101, '/help'))
    assert.equal(first.ok, true)
    assert.equal(first.created, true)
    const second = await queue.enqueueCommand(commandItem(101, '/help'))
    assert.equal(second.ok, true)
    assert.equal(second.created, false)
    const snapshot = await queue.snapshot()
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0].command.text, '/help')
    assert.equal(snapshot.items[0].command.botId, '123456')
  })
})

test('два устройства: одновременный claim одного command — ровно один победитель', async () => {
  await withQueueWorld(async ({ make }) => {
    // A realistic claim wait leaves time for the competitor's push to land before
    // the winner confirms; the production default is 3000 ms.
    const a = make({ id: 'dev-a', name: 'A' }, { claimWaitMs: 400 })
    const b = make({ id: 'dev-b', name: 'B' }, { claimWaitMs: 400 })
    const enqueued = await a.enqueueCommand(commandItem(201, '/sessions'))
    assert.equal(enqueued.created, true)
    await b.sync()
    const [claimA, claimB] = await Promise.all([
      a.claimCommand(enqueued.commandId),
      b.claimCommand(enqueued.commandId),
    ])
    const winners = [claimA, claimB].filter(result => result.acquired === true)
    assert.equal(winners.length, 1, `победителей: ${winners.length} (${JSON.stringify([claimA, claimB])})`)
    const winnerDevice = winners[0].winner.deviceId
    assert.ok(winnerDevice === 'dev-a' || winnerDevice === 'dev-b')
    // Both claims stay in the repository as history.
    await a.sync()
    const claims = await a.claimsFor(enqueued.commandId)
    assert.equal(claims.length, 2)
  })
})

test('протухший claim: повторная попытка получает attempt 2', async () => {
  await withQueueWorld(async ({ make }) => {
    let clock = 1_000_000
    const queue = make({ id: 'dev-a', name: 'A' }, { now: () => clock, ttlMs: 120_000 })
    const enqueued = await queue.enqueueCommand(commandItem(301, '/help'))
    const first = await queue.claimCommand(enqueued.commandId)
    assert.equal(first.acquired, true)
    assert.equal(first.claim.attempt, 1)
    clock += 120_001
    const second = await queue.claimCommand(enqueued.commandId)
    assert.equal(second.acquired, true)
    assert.equal(second.claim.attempt, 2)
    assert.equal((await queue.claimsFor(enqueued.commandId)).length, 2)
  })
})

test('живой claim другого устройства не перехватывается', async () => {
  await withQueueWorld(async ({ make }) => {
    const a = make({ id: 'dev-a', name: 'A' })
    const b = make({ id: 'dev-b', name: 'B' })
    const enqueued = await a.enqueueCommand(commandItem(351, '/help'))
    const claimed = await a.claimCommand(enqueued.commandId)
    assert.equal(claimed.acquired, true)
    const other = await b.claimCommand(enqueued.commandId)
    assert.equal(other.acquired, false)
    assert.equal(other.reason, 'claimed')
    assert.equal(other.winner.deviceId, 'dev-a')
  })
})

test('done: команда не выдаётся повторно и попадает в счётчики', async () => {
  await withQueueWorld(async ({ make }) => {
    const a = make({ id: 'dev-a', name: 'A' })
    const b = make({ id: 'dev-b', name: 'B' })
    const enqueued = await a.enqueueCommand(commandItem(401, '/status'))
    const claim = await a.claimCommand(enqueued.commandId)
    assert.equal(claim.acquired, true)
    await a.finishCommand(enqueued.commandId, { status: 'ok', output: 'готово', attempt: 1 })
    await b.sync()
    const again = await b.claimCommand(enqueued.commandId)
    assert.equal(again.acquired, false)
    assert.equal(again.reason, 'done')
    const snapshot = await b.snapshot()
    assert.deepEqual(snapshot.counts, { total: 1, new: 0, inProgress: 0, done: 1 })
    assert.equal(snapshot.items[0].result.status, 'ok')
    assert.equal(snapshot.items[0].done, true)
  })
})

test('счётчики: новые, в работе, готово', async () => {
  await withQueueWorld(async ({ make }) => {
    const queue = make({ id: 'dev-a', name: 'A' })
    const first = await queue.enqueueCommand(commandItem(501, '/help'))
    const second = await queue.enqueueCommand(commandItem(502, '/status'))
    assert.deepEqual((await queue.snapshot()).counts, { total: 2, new: 2, inProgress: 0, done: 0 })
    await queue.claimCommand(first.commandId)
    assert.deepEqual((await queue.snapshot()).counts, { total: 2, new: 1, inProgress: 1, done: 0 })
    await queue.finishCommand(first.commandId, { status: 'ok', output: 'ok' })
    assert.deepEqual((await queue.snapshot()).counts, { total: 2, new: 1, inProgress: 0, done: 1 })
    await queue.claimCommand(second.commandId)
    await queue.finishCommand(second.commandId, { status: 'error', output: 'сбой' })
    assert.deepEqual((await queue.snapshot()).counts, { total: 2, new: 0, inProgress: 0, done: 2 })
  })
})

test('параллельные enqueue двух устройств: все команды есть в remote', async () => {
  await withQueueWorld(async ({ make }) => {
    const a = make({ id: 'dev-a', name: 'A' })
    const b = make({ id: 'dev-b', name: 'B' })
    const writes = []
    for (let index = 0; index < 4; index += 1) {
      writes.push(a.enqueueCommand(commandItem(600 + index, `/ask a${index}`)))
      writes.push(b.enqueueCommand(commandItem(700 + index, `/ask b${index}`)))
    }
    const results = await Promise.all(writes)
    assert.equal(results.every(result => result.ok), true, JSON.stringify(results.filter(result => !result.ok)))
    const fresh = make({ id: 'dev-c', name: 'C' })
    await fresh.sync()
    const snapshot = await fresh.snapshot()
    assert.equal(snapshot.counts.total, 8)
  })
})

test('status: файл публикуется владельцем и виден другому устройству', async () => {
  await withQueueWorld(async ({ make }) => {
    const a = make({ id: 'dev-a', name: 'A' })
    const b = make({ id: 'dev-b', name: 'B' })
    await a.updateStatus({ listener: true, lastSyncAt: Date.now(), lastError: '', version: '0.4.0' })
    await b.sync()
    const statuses = await b.statuses()
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].deviceId, 'dev-a')
    assert.equal(statuses[0].listener, true)
  })
})

test('offset: сохраняется после батча и читается обратно', async () => {
  await withQueueWorld(async ({ make }) => {
    const queue = make({ id: 'dev-a', name: 'A' })
    const result = await queue.commitBatch({ commands: [commandItem(801, '/help')], offset: 802 })
    assert.equal(result.ok, true)
    assert.equal(await queue.readOffset(), 802)
    const fresh = make({ id: 'dev-c', name: 'C' })
    await fresh.sync()
    assert.equal((await fresh.snapshot()).counts.total, 1)
  })
})

test('очередь не содержит токена и приватных полей', async () => {
  await withQueueWorld(async ({ make, root }) => {
    const queue = make({ id: 'dev-a', name: 'A' })
    await queue.enqueueCommand(commandItem(901, '/help'))
    const files = await readdir(join(root, 'clone-dev-a', 'inbox', 'commands'))
    assert.equal(files.length, 1)
    const text = await readFile(join(root, 'clone-dev-a', 'inbox', 'commands', files[0]), 'utf8')
    assert.ok(!text.includes('123456789:'))
    const record = JSON.parse(text)
    assert.equal(record.kind, 'command')
    assert.equal(record.botId, '123456')
    assert.equal(record.chatId, '555')
    assert.equal(record.deviceId, 'dev-a')
  })
})
