import { MongoClient } from 'mongodb'
import fs from 'fs'
import crypto from 'crypto'
import readline from 'readline/promises'
import { stdin as input, stdout as output } from 'process'

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto
}

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

if (!ATLAS_URI || !LOCAL_URI) {
  console.error('❌ ATLAS_URI and LOCAL_URI must be set in environment or .env file')
  process.exit(1)
}

async function runInitialSync() {
  let atlasClient, localClient
  const rl = readline.createInterface({ input, output })

  try {
    console.log('🔌 Connecting to Atlas and Local MongoDB...')
    atlasClient = new MongoClient(ATLAS_URI)
    localClient = new MongoClient(LOCAL_URI)

    await atlasClient.connect()
    await localClient.connect()
    console.log('✅ Connected successfully')

    let defaultDb = 'test'
    let dbs = []

    // Attempt to extract default database from ATLAS_URI if possible
    try {
      const parsedUri = new URL(ATLAS_URI)
      const pathName = parsedUri.pathname.replace(/^\//, '')
      if (pathName) {
        defaultDb = decodeURIComponent(pathName.split('?')[0])
      }
    } catch (e) {
      // ignore
    }

    try {
      console.log('📋 Fetching available databases from Atlas...')
      const adminDB = atlasClient.db().admin()
      const dbsInfo = await adminDB.listDatabases()
      dbs = dbsInfo.databases.map((db) => db.name).filter((name) => name !== 'admin' && name !== 'local' && name !== 'config')
    } catch (err) {
      console.log(`ℹ️ Note: Could not list all databases automatically (requires admin cluster privileges).`)
    }

    let selectedDbs = []

    if (dbs.length > 0) {
      console.log('\nFound the following databases in Atlas:')
      dbs.forEach((name, idx) => {
        const isDefault = name === defaultDb ? ' (default)' : ''
        console.log(`  [${idx + 1}] ${name}${isDefault}`)
      })

      console.log('\n--------------------------------------------------')
      const dbSelectionInput = await rl.question(
        `❓ Which database(s) do you want to replicate?\n` +
          `   • To use "${defaultDb}", press [Enter]\n` +
          `   • To sync ALL databases, type "all"\n` +
          `   • To sync SPECIFIC databases, enter numbers or names comma-separated (e.g. "1,3" or "test,cathub")\n` +
          `👉 Selection: `
      )

      const cleanedDbSelection = dbSelectionInput.trim().toLowerCase()
      if (cleanedDbSelection === '') {
        selectedDbs = [defaultDb]
      } else if (cleanedDbSelection === 'all') {
        selectedDbs = [...dbs]
      } else {
        const selections = cleanedDbSelection.split(',').map((s) => s.trim())
        for (const sel of selections) {
          if (!sel) continue

          // Try parsing as a number (1-based index)
          const num = parseInt(sel, 10)
          if (!isNaN(num) && num > 0 && num <= dbs.length) {
            selectedDbs.push(dbs[num - 1])
          } else {
            // Look up by exact name (case-insensitive search for convenience, but matching original case)
            const matchedDb = dbs.find((name) => name.toLowerCase() === sel)
            if (matchedDb) {
              selectedDbs.push(matchedDb)
            } else {
              selectedDbs.push(sel) // fallback to input
            }
          }
        }
      }
    } else {
      selectedDbs = [defaultDb]
      console.log(`ℹ️ Proceeding with default database: "${defaultDb}"`)
    }

    // Remove duplicates from databases list
    selectedDbs = [...new Set(selectedDbs)]

    if (selectedDbs.length === 0) {
      console.log('⚠️ No valid databases selected. Exiting.')
      rl.close()
      return
    }

    console.log(`\n📂 Selected Databases: ${selectedDbs.map((d) => `"${d}"`).join(', ')}`)

    const dbSyncPlan = [] // Array of { dbName, collectionsToSync, untouchedCollections }

    if (selectedDbs.length === 1) {
      const dbName = selectedDbs[0]
      const atlasDB = atlasClient.db(dbName)

      console.log(`📋 Fetching collections from Atlas database: "${dbName}"...`)
      const rawCollections = await atlasDB.listCollections().toArray()
      const collections = rawCollections.map((c) => c.name).filter((name) => !name.startsWith('system.'))

      if (collections.length === 0) {
        console.log(`⚠️ No collections found in Atlas database "${dbName}".`)
        rl.close()
        return
      }

      // Print available collections
      console.log('\nFound the following collections in Atlas database:')
      collections.forEach((name, idx) => {
        console.log(`  [${idx + 1}] ${name}`)
      })

      console.log('\n--------------------------------------------------')
      const selectionInput = await rl.question(
        '❓ Which collections do you want to replicate?\n' +
          '   • To sync ALL, press [Enter] or type "all"\n' +
          '   • To sync SPECIFIC collections, enter numbers or names comma-separated (e.g. "1,3" or "users,orders")\n' +
          '   • To exit, type "exit" or "none"\n' +
          '👉 Selection: '
      )

      const cleanedSelection = selectionInput.trim().toLowerCase()

      if (cleanedSelection === 'exit' || cleanedSelection === 'none') {
        console.log('👋 Sync cancelled by user.')
        rl.close()
        return
      }

      let collectionsToSync = []
      if (cleanedSelection === '' || cleanedSelection === 'all') {
        collectionsToSync = [...collections]
      } else {
        const selections = cleanedSelection.split(',').map((s) => s.trim())
        for (const sel of selections) {
          if (!sel) continue

          // Try parsing as a number (1-based index)
          const num = parseInt(sel, 10)
          if (!isNaN(num) && num > 0 && num <= collections.length) {
            collectionsToSync.push(collections[num - 1])
          } else {
            // Look up by exact name (case-insensitive search for convenience, but matching original case)
            const matchedName = collections.find((c) => c.toLowerCase() === sel)
            if (matchedName) {
              collectionsToSync.push(matchedName)
            } else {
              console.warn(`⚠️ Collection "${sel}" not found in Atlas. Skipping this selection.`)
            }
          }
        }
      }

      collectionsToSync = [...new Set(collectionsToSync)]

      if (collectionsToSync.length === 0) {
        console.log('⚠️ No valid collections selected for sync. Exiting.')
        rl.close()
        return
      }

      const untouched = collections.filter((c) => !collectionsToSync.includes(c))
      dbSyncPlan.push({ dbName, collectionsToSync, untouchedCollections: untouched })
    } else {
      // Multiple databases selected!
      console.log('\n--------------------------------------------------')
      const multiDbMode = await rl.question(
        `❓ You selected ${selectedDbs.length} databases.\n` +
          `   Do you want to replicate ALL collections in ALL selected databases?\n` +
          `   • Press [Enter] or type "y" for YES (fully replicate whole databases with all their collections)\n` +
          `   • Type "n" to manually choose collections for each database\n` +
          `👉 Selection: `
      )

      const syncAllCollections = multiDbMode.trim().toLowerCase() === '' || multiDbMode.trim().toLowerCase() === 'y' || multiDbMode.trim().toLowerCase() === 'yes'

      if (syncAllCollections) {
        for (const dbName of selectedDbs) {
          const atlasDB = atlasClient.db(dbName)
          const rawCollections = await atlasDB.listCollections().toArray()
          const collections = rawCollections.map((c) => c.name).filter((name) => !name.startsWith('system.'))
          dbSyncPlan.push({ dbName, collectionsToSync: collections, untouchedCollections: [] })
        }
      } else {
        // Prompt for each database
        for (const dbName of selectedDbs) {
          console.log(`\n==================================================`)
          console.log(`📂 Database: "${dbName}"`)
          const atlasDB = atlasClient.db(dbName)
          const rawCollections = await atlasDB.listCollections().toArray()
          const collections = rawCollections.map((c) => c.name).filter((name) => !name.startsWith('system.'))

          if (collections.length === 0) {
            console.log(`⚠️ No collections found in Atlas database "${dbName}". Skipping collection selection.`)
            dbSyncPlan.push({ dbName, collectionsToSync: [], untouchedCollections: [] })
            continue
          }

          console.log('\nFound the following collections:')
          collections.forEach((name, idx) => {
            console.log(`  [${idx + 1}] ${name}`)
          })

          const selectionInput = await rl.question(
            `❓ Which collections in "${dbName}" to replicate?\n` +
              '   • To sync ALL, press [Enter] or type "all"\n' +
              '   • To sync SPECIFIC collections, enter numbers or names comma-separated\n' +
              '   • To SKIP this database completely, type "skip" or "none"\n' +
              '👉 Selection: '
          )

          const cleanedSelection = selectionInput.trim().toLowerCase()

          if (cleanedSelection === 'skip' || cleanedSelection === 'none') {
            dbSyncPlan.push({ dbName, collectionsToSync: [], untouchedCollections: collections })
            continue
          }

          let collectionsToSync = []
          if (cleanedSelection === '' || cleanedSelection === 'all') {
            collectionsToSync = [...collections]
          } else {
            const selections = cleanedSelection.split(',').map((s) => s.trim())
            for (const sel of selections) {
              if (!sel) continue
              const num = parseInt(sel, 10)
              if (!isNaN(num) && num > 0 && num <= collections.length) {
                collectionsToSync.push(collections[num - 1])
              } else {
                const matchedName = collections.find((c) => c.toLowerCase() === sel)
                if (matchedName) {
                  collectionsToSync.push(matchedName)
                } else {
                  console.warn(`⚠️ Collection "${sel}" not found in database "${dbName}". Skipping.`)
                }
              }
            }
          }
          collectionsToSync = [...new Set(collectionsToSync)]
          const untouched = collections.filter((c) => !collectionsToSync.includes(c))
          dbSyncPlan.push({ dbName, collectionsToSync, untouchedCollections: untouched })
        }
      }
    }

    // Determine if there is anything to sync
    const hasWork = dbSyncPlan.some((plan) => plan.collectionsToSync.length > 0)
    if (!hasWork) {
      console.log('⚠️ No collections selected across all databases. Exiting.')
      rl.close()
      return
    }

    console.log('\n--------------------------------------------------')
    console.log('📋 Sync Plan Summary:')
    for (const plan of dbSyncPlan) {
      if (plan.collectionsToSync.length === 0) continue
      console.log(`\n📂 Database: "${plan.dbName}"`)
      console.log('🔥 REPLICATING (Will clear local data and copy from Atlas):')
      plan.collectionsToSync.forEach((name) => console.log(`   • ${name}`))

      if (plan.untouchedCollections.length > 0) {
        console.log('🔒 UNTOUCHED (Will remain exactly as they are in local DB):')
        plan.untouchedCollections.forEach((name) => console.log(`   • ${name}`))
      }
    }
    console.log('--------------------------------------------------')

    const confirmInput = await rl.question('❓ Proceed with sync plan? (y/N): ')
    const confirmed = confirmInput.trim().toLowerCase()

    if (confirmed !== 'y' && confirmed !== 'yes') {
      console.log('👋 Sync cancelled.')
      rl.close()
      return
    }

    // We can close the readline interface now
    rl.close()

    for (const plan of dbSyncPlan) {
      if (plan.collectionsToSync.length === 0) continue

      console.log(`\n📂 >>> Processing Database: "${plan.dbName}" <<<`)
      const atlasDB = atlasClient.db(plan.dbName)
      const localDB = localClient.db(plan.dbName)

      for (const colName of plan.collectionsToSync) {
        console.log(`\n  📦 Syncing collection: "${colName}"`)
        const atlasCol = atlasDB.collection(colName)
        const localCol = localDB.collection(colName)

        // Clean local collection first
        console.log(`    🧹 Clearing local collection "${colName}"...`)
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
            console.log(`    ⚡ Synced ${totalSynced} documents...`)
            batch = []
          }
        }

        if (batch.length > 0) {
          await localCol.insertMany(batch)
          totalSynced += batch.length
          batch = []
        }

        console.log(`    🎉 Finished syncing "${colName}" (${totalSynced} documents total)`)
      }
    }

    console.log('\n✨ Initial Database Sync Completed Successfully!')
  } catch (error) {
    console.error('\n🔥 Sync failed:', error)
    rl.close()
    process.exit(1)
  } finally {
    if (atlasClient) await atlasClient.close()
    if (localClient) await localClient.close()
  }
}

runInitialSync()
