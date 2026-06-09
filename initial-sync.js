import { MongoClient } from 'mongodb'
import fs from 'fs'

// Load local .env if present
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf8')
  envContent.split('\n').forEach((line) => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/)
    if (match) {
      const key = match[1]
      let value = match[2] || ''
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      process.env[key] = value
    }
  })
}

const ATLAS_URI = process.env.ATLAS_URI
const LOCAL_URI = process.env.LOCAL_URI
const DB_NAME = process.env.DB_NAME || 'test'

if (!ATLAS_URI || !LOCAL_URI) {
  console.error('❌ ATLAS_URI and LOCAL_URI must be set in environment or .env file')
  process.exit(1)
}

async function runInitialSync() {
  let atlasClient, localClient

  try {
    console.log('🔌 Connecting to Atlas and Local MongoDB...')
    atlasClient = new MongoClient(ATLAS_URI)
    localClient = new MongoClient(LOCAL_URI)

    await atlasClient.connect()
    await localClient.connect()
    console.log('✅ Connected successfully')

    const atlasDB = atlasClient.db(DB_NAME)
    const localDB = localClient.db(DB_NAME)

    console.log(`📋 Fetching collections from Atlas database: "${DB_NAME}"...`)
    const collections = await atlasDB.listCollections().toArray()

    if (collections.length === 0) {
      console.log('⚠️ No collections found in Atlas database.')
      return
    }

    for (const colInfo of collections) {
      const colName = colInfo.name
      if (colName.startsWith('system.')) {
        continue // Skip system collections
      }

      console.log(`\n📦 Syncing collection: "${colName}"`)
      const atlasCol = atlasDB.collection(colName)
      const localCol = localDB.collection(colName)

      // Clean local collection first
      console.log(`  🧹 Clearing local collection "${colName}"...`)
      await localCol.deleteMany({})

      // Copy data in batches of 1000 to keep memory low
      const cursor = atlasCol.find({})
      let batch = []
      let totalSynced = 0
      const BATCH_SIZE = 1000

      while (await cursor.hasNext()) {
        const doc = await cursor.next()
        batch.push(doc)

        if (batch.length >= BATCH_SIZE) {
          await localCol.insertMany(batch)
          totalSynced += batch.length
          console.log(`  ⚡ Synced ${totalSynced} documents...`)
          batch = []
        }
      }

      if (batch.length > 0) {
        await localCol.insertMany(batch)
        totalSynced += batch.length
        batch = []
      }

      console.log(`  🎉 Finished syncing "${colName}" (${totalSynced} documents total)`)
    }

    console.log('\n✨ Initial Database Sync Completed Successfully!')
  } catch (error) {
    console.error('\n🔥 Sync failed:', error)
    process.exit(1)
  } finally {
    if (atlasClient) await atlasClient.close()
    if (localClient) await localClient.close()
  }
}

runInitialSync()
