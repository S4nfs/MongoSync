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

// �️ Ensure MongoDB Replica Set is initialized automatically
async function ensureReplicaSet() {
  const MONGO_USER = process.env.MONGO_USER
  const MONGO_PASS = process.env.MONGO_PASS

  if (!MONGO_USER || !MONGO_PASS) {
    console.warn('⚠️ MONGO_USER or MONGO_PASS not found in environment. Skipping auto replica set check.')
    return
  }

  // Construct standalone connection to mongo1 with directConnection=true to query/administer this node specifically
  const standaloneUri = `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASS)}@mongo1:27017/?authSource=admin&directConnection=true`

  console.log('🔍 Checking if local MongoDB Replica Set is initialized...')

  let initialized = false
  let attempts = 0
  const maxAttempts = 12 // 1 minute total (12 * 5s)

  while (!initialized && attempts < maxAttempts) {
    let client
    try {
      client = new MongoClient(standaloneUri, {
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000,
      })
      await client.connect()
      const adminDB = client.db('admin')

      try {
        const status = await adminDB.command({ replSetGetStatus: 1 })
        console.log(`✅ Replica set already initialized: "${status.set}"`)
        initialized = true
      } catch (err) {
        // Code 94 is NotYetInitialized
        if (err.code === 94 || err.message?.includes('not initialized') || err.message?.includes('NotYetInitialized')) {
          console.log('⚙️ Replica set not initialized yet. Initiating now...')
          await adminDB.command({
            replSetInitiate: {
              _id: 'rs0',
              members: [
                { _id: 0, host: 'mongo1:27017', priority: 10 },
                { _id: 1, host: 'mongo2:27017', priority: 1 },
                { _id: 2, host: 'mongo3:27017', priority: 1 },
              ],
            },
          })
          console.log('🎉 Replica set successfully initiated! Waiting 10s for primary election...')
          await new Promise((res) => setTimeout(res, 10000))
          initialized = true
        } else {
          // Some other error, might be that it is still starting up or auth is not ready
          throw err
        }
      }
    } catch (err) {
      attempts++
      console.warn(`⏳ Local MongoDB node "mongo1" is not fully ready or replica set is transitioning. Attempt ${attempts}/${maxAttempts}. Error: ${err.message}`)
      if (attempts >= maxAttempts) {
        console.error('❌ Reached maximum attempts waiting for replica set initialization. Continuing anyway...')
        break
      }
      await new Promise((res) => setTimeout(res, 5000))
    } finally {
      if (client) {
        await client.close().catch(() => {})
      }
    }
  }
}

// �🔁 Exponential backoff retry
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
  // ⚙️ Automatically ensure local Replica Set is initialized before we begin syncing
  try {
    await ensureReplicaSet()
  } catch (err) {
    console.error('❌ Auto-replica set initialization failed:', err.message)
  }

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
