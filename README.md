# 🧠 MongoSync

## 3. What this system actually does

### 👉 Mongo Replica Set

In a 3-node MongoDB Replica Set, all nodes maintain an identical copy of the data:

- **1 PRIMARY:** Receives all write operations.
- **2 SECONDARY:** Copy data from the primary asynchronously to maintain redundancy.

If the PRIMARY node goes down, an election is held automatically, and one of the SECONDARIES becomes the new PRIMARY.

### 👉 Your Sync System

```mermaid
graph TD
    Atlas[MongoDB Atlas] -->|Change Stream| Sync[Node.js Sync Service]
    Sync -->|Apply Writes| Local[Local MongoDB Replica Set]
```

The sync service listens to MongoDB Atlas **Change Streams** in real time and safely (idempotent replication) applies those changes directly to your local replica set.

---

## 🧱 4. Setup & Running Instructions

### 🔥 Step 1: Create the Replica Set Keyfile

A keyfile is required for internal authentication between the replica set members.

```bash
openssl rand -base64 756 | tr -d '\n' > mongo-keyfile
chmod 400 mongo-keyfile
chown 999:999 mongo-keyfile
```

### 📦 Step 2: Create `.env` file

Create a file named `.env` in the root of your project directory and add your database configuration:

```env
MONGO_USER=mydb
MONGO_PASS=password

# Database name to sync (default is "test" if not specified)
DB_NAME=test

# MongoDB Atlas URI (Remember to URL-encode special characters like + to %2B in the password)
ATLAS_URI=mongodb+srv://mydb:password@cluster0.ibohual.mongodb.net

# Local Replica Set URI
LOCAL_URI=mongodb://mydb:password@mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&authSource=admin
```

### 🐳 Step 3: Run with Docker Compose

Make sure your `docker-compose.yml` is configured properly, then start the entire stack:

```bash
docker compose down -v
docker compose up -d --build
```

### ⚙️ Step 4: Initialize the Replica Set

Run this direct command on your host terminal to initialize the replica set (no need to log into the shell manually). This assigns a higher priority (`10`) to `mongo1` to ensure it is always elected as the writable `PRIMARY` (crucial for external apps connecting to `localhost:27017`):

```bash
docker exec -it mongo1 mongosh -u mydb -p 'password' --authenticationDatabase admin --eval "
rs.initiate({
  _id: 'rs0',
  members: [
    { _id: 0, host: 'mongo1:27017', priority: 10 },
    { _id: 1, host: 'mongo2:27017', priority: 1 },
    { _id: 2, host: 'mongo3:27017', priority: 1 }
  ]
})
"
```

### 🔁 Step 5: Verify the Sync Service Logs

Check if the sync service is running and connected successfully:

```bash
docker logs -f mongo-sync
```

### 🔍 Step 6: Test the Sync & Verify Node Replication

#### 1. Insert a document into your MongoDB Atlas database:

Use your local terminal, Mongo Compass, or Atlas dashboard to insert a test document into the `test` collection in the `test` database:

```javascript
db.test.insertOne({ test: 'sync check', timestamp: new Date() })
```

#### 2. Check document count on the local PRIMARY (`mongo1`):

Run this direct command on the host terminal to count the documents in your local database:

```bash
docker exec -it mongo1 mongosh -u mydb -p 'password' --authenticationDatabase admin --eval "db.getSiblingDB('test').test.countDocuments()"
```

#### 3. Verify replication sync status across ALL nodes:

To confirm if the replica set members (`mongo2` and `mongo3`) have fully synchronized with the primary (`mongo1`), run this direct command on the host:

```bash
docker exec -it mongo1 mongosh -u mydb -p 'password' --authenticationDatabase admin --eval "rs.printSecondaryReplicationInfo()"
```

If this prints `0 seconds behind the primary` for both secondary nodes, your replicas are 100% in sync!

### 💾 Step 7 (REQUIRED for existing data): Multi-Database & Collection Initial Sync

> ⚠️ **IMPORTANT:** The default `mongo-sync` service listens to **new real-time changes** (Change Streams) from Atlas. It **does not** automatically copy pre-existing data that was already in Atlas before you started the sync.
>
> To copy existing databases/collections from Atlas to your local replica set, run our built-in interactive utility script. It features a fully interactive menu letting you select one or more databases and specific collections to replicate (without requiring any tools like `mongodump` or `mongorestore`!):

#### Run inside Docker (Interactive Mode)

```bash
docker exec -it mongo-sync npm run initial-sync
```

#### Run locally from Host Machine

```bash
npm install
node initial-sync.js
```

#### Features of the utility:

- **Multi-Database Selection:** Shows all databases in Atlas and lets you select multiple databases to replicate (by number, name, or typing `all`).
- **Specific Collection Filtering:** Lets you choose to fully replicate the whole database (all collections) or selectively prompt you database-by-database to sync specific collections (comma-separated).
- **Plan Summary:** Generates a summary plan of exactly what will be deleted and replicated, and what will remain untouched before asking for confirmation.

```

```
