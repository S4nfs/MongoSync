import { MongoClient } from 'mongodb'
import crypto from 'crypto'

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto
}
const ATLAS_URI = process.env.ATLAS_URI
const LOCAL_URI = process.env.LOCAL_URI
const DB_NAME = process.env.DB_NAME || 'test'

const MAX_RETRIES = 5
const INITIAL_DELAY = 100

// 🔁 Exponential backoff retry
async function retryOperation(fn, retries = MAX_RETRIES) {
  let delay = INITIAL_DELAY

  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === retries - 1) throw err

      console.warn(`Retrying in ${delay}ms...`)
      await new Promise((res) => setTimeout(res, delay))
      delay *= 2
    }
  }
}

// 🧠 Apply change safely (idempotent)
async function applyChange(localDB, change) {
  const { ns, operationType, documentKey, fullDocument, updateDescription } = change

  const collection = localDB.collection(ns.coll)

  switch (operationType) {
    case 'insert':
    case 'replace':
      await collection.updateOne(
        { _id: fullDocument._id },
        { $set: fullDocument },
        { upsert: true } // idempotent
      )
      break

    case 'update':
      await collection.updateOne({ _id: documentKey._id }, { $set: updateDescription.updatedFields })
      break

    case 'delete':
      await collection.deleteOne({ _id: documentKey._id })
      break

    default:
      console.log(`Skipping operation: ${operationType}`)
  }
}

async function startSync() {
  while (true) {
    let atlasClient, localClient

    try {
      console.log('🔌 Connecting to databases...')

      atlasClient = new MongoClient(ATLAS_URI)
      localClient = new MongoClient(LOCAL_URI)

      await atlasClient.connect()
      await localClient.connect()

      console.log('✅ Connected')

      const atlasDB = atlasClient.db(DB_NAME)
      const localDB = localClient.db(DB_NAME)

      const tokenCollection = localDB.collection('sync_tokens')
      const dlq = localDB.collection('dead_letter_queue')

      // 🔹 Load resume token
      const saved = await tokenCollection.findOne({ _id: 'global' })

      const options = saved && saved.token ? { resumeAfter: saved.token } : {}
      console.log('🚀 Starting change stream...')

      const changeStream = atlasDB.watch([], options)

      for await (const change of changeStream) {
        try {
          await retryOperation(() => applyChange(localDB, change))

          // ✅ Save token AFTER success
          await tokenCollection.updateOne({ _id: 'global' }, { $set: { token: change._id } }, { upsert: true })
        } catch (err) {
          console.error('❌ Failed to process event:', err.message)

          // 📦 Push to DLQ
          await dlq.insertOne({
            change,
            error: err.message,
            timestamp: new Date(),
          })
        }
      }
    } catch (err) {
      console.error('🔥 Sync crashed:', err.message)

      // If the change stream resume token is invalid or no longer in the oplog, delete it so we can start fresh
      if (err.code === 286 || (err.message && err.message.includes('resume point may no longer be in the oplog'))) {
        console.warn('⚠️ Saved resume token is invalid or no longer exists in Atlas oplog. Clearing token and restarting from latest change...')
        if (localClient) {
          try {
            const tokenCollection = localClient.db(DB_NAME).collection('sync_tokens')
            await tokenCollection.deleteOne({ _id: 'global' })
          } catch (tokenErr) {
            console.error('❌ Failed to clear invalid resume token:', tokenErr.message)
          }
        }
      }

      // wait before reconnect
      await new Promise((res) => setTimeout(res, 5000))
    } finally {
      if (atlasClient) await atlasClient.close().catch(() => {})
      if (localClient) await localClient.close().catch(() => {})
    }
  }
}

startSync()
