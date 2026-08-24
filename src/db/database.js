import Dexie from 'dexie'
import { uuid } from '../lib/uuid.js'
import { hashSecret } from '../lib/crypto.js'
import { supabaseEnabled } from '../sync/supabase.js'

// IndexedDB store. Holds ALL data locally so the app works fully offline.
// Photos are kept as Blobs inside the `photos` store (IndexedDB handles large
// binary data, unlike localStorage which is tiny and text-only).
export const db = new Dexie('machinery_piece_rates')

db.version(1).stores({
  // `id` is a client-generated uuid (stable across sync).
  operators: 'id, name, active, updatedAt, syncStatus',
  pieceRates: 'id, name, active, updatedAt, syncStatus',
  areas: 'id, name, active, updatedAt, syncStatus',
  // Compound indexes speed up the open-tasks list and the monthly summary.
  tasks:
    'id, operatorId, status, syncStatus, monthKey, dayKey, startTime, updatedAt, [operatorId+status], [operatorId+monthKey], [monthKey+status]',
  photos: 'id, taskId, kind, syncStatus, updatedAt',
  // Records deleted locally that still need to be removed from the server.
  tombstones: 'id, table, createdAt',
  // key/value: currency, admin auth, recovery hash, last sync cursor, etc.
  meta: 'key'
})

// v2: Company -> Machine hierarchy. Operators are now a self-typed username
// (no operator accounts); the per-machine PIN gates login. Tasks gain
// company/machine fields and indexes for the new queries.
db.version(2).stores({
  companies: 'id, name, active, updatedAt, syncStatus',
  machines: 'id, companyId, name, active, updatedAt, syncStatus',
  tasks:
    'id, status, syncStatus, monthKey, dayKey, startTime, updatedAt, companyId, machineId, operatorName, [companyId+operatorName+status], [companyId+operatorName+monthKey], [companyId+monthKey]'
})

// v3: the operator "account" is the MACHINE (company + machine), not the typed
// name — so a machine's records are shared regardless of who is signed in.
// Index tasks by machine for the open list and the monthly claim.
db.version(3).stores({
  tasks:
    'id, status, syncStatus, monthKey, dayKey, startTime, updatedAt, companyId, machineId, operatorName, [machineId+status], [machineId+monthKey], [companyId+monthKey]'
})

// v4: the account is the OPERATOR (one operator can use many machines). The
// machine + piece rate are chosen when finishing a task. Piece rates belong to
// a machine; operators carry a list of machines the admin lets them use.
db.version(4).stores({
  pieceRates: 'id, name, active, updatedAt, syncStatus, machineId',
  tasks:
    'id, status, syncStatus, monthKey, dayKey, startTime, updatedAt, operatorId, companyId, machineId, [operatorId+status], [operatorId+monthKey], [companyId+monthKey], [machineId+monthKey]'
})

// v5: per-operator, per-month claim-form extras (the Bahagian B incentives),
// saved + synced so an admin can key them in ahead and they persist per month.
// The id is `${operatorId}__${monthKey}` so an upsert always merges the same row.
db.version(5).stores({
  claims: 'id, operatorId, monthKey, updatedAt, syncStatus, [operatorId+monthKey]'
})

// v6: per-month payroll lock. When a month is locked its records + payroll can
// no longer be modified (anywhere) until an admin unlocks it. id = the monthKey.
db.version(6).stores({
  monthLocks: 'id, updatedAt, syncStatus'
})

// v7: GPS distance tracks recorded on the map by operators while finishing a
// meter-unit piece-rate task. Points are stored inline ([{lat,lng,t}]); a month
// of an operator's tracks stays viewable/exportable (KML/GPX).
db.version(7).stores({
  tracks: 'id, operatorId, taskId, monthKey, updatedAt, syncStatus, [operatorId+monthKey]'
})

// ---- meta helpers ---------------------------------------------------------

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key)
  return row ? row.value : fallback
}

export async function setMeta(key, value) {
  await db.meta.put({ key, value })
  return value
}

// ---- first-run seed -------------------------------------------------------

/**
 * Seeds a little demo data + defaults the first time the app is opened so the
 * operator login and forms are usable immediately. Idempotent.
 * The demo operator / rates / areas can be edited or deleted by the admin.
 */
export async function seedIfEmpty() {
  // Versioned key so later model changes also seed/migrate on already-installed
  // devices.
  if (await getMeta('seeded.v7')) return

  // Currency default is fine to set everywhere.
  if ((await getMeta('currency')) == null) await setMeta('currency', 'RM')

  // When connected to Supabase, NEVER seed demo data — the real data syncs down
  // from the server. Seeding here would create a brand-new "Demo Company" on
  // every fresh device/browser and push duplicates up. The demo data exists only
  // to make the fully-offline / local-only build usable out of the box.
  if (supabaseEnabled) {
    await setMeta('seeded.v7', true)
    return
  }

  const now = new Date().toISOString()
  const demoPin = await hashSecret('1234')

  await db.transaction(
    'rw',
    db.companies, db.machines, db.pieceRates, db.areas, db.operators, db.tasks, db.meta,
    async () => {
      // Company + machine — only on a truly fresh install.
      let machineId
      if ((await db.companies.count()) === 0) {
        const companyId = uuid()
        machineId = uuid()
        await db.companies.add({ id: companyId, name: 'Demo Company', active: true, updatedAt: now, syncStatus: 'pending' })
        await db.machines.add({ id: machineId, companyId, name: 'Excavator 1', active: true, updatedAt: now, syncStatus: 'pending' })
      } else {
        const m = await db.machines.toCollection().first()
        machineId = m?.id || null
      }
      const firstCompany = await db.companies.toCollection().first()
      const opCompanyId = firstCompany?.id || null

      // Piece rates belong to a machine. Seed under the demo machine, or adopt
      // any old machine-less rates onto it.
      if (machineId) {
        if ((await db.pieceRates.count()) === 0) {
          await db.pieceRates.bulkAdd([
            prate('Repair road', 'm', 25, machineId, now),
            prate('Clear drain', 'm', 8, machineId, now),
            prate('Load & haul soil', 'trip', 60, machineId, now)
          ])
        } else {
          const orphans = await db.pieceRates.filter((r) => !r.machineId).toArray()
          for (const r of orphans) {
            await db.pieceRates.update(r.id, { machineId, updatedAt: now, syncStatus: 'pending' })
          }
        }
      }

      if ((await db.areas.count()) === 0) {
        await db.areas.bulkAdd([
          area('Zone A', now, opCompanyId),
          area('Zone B', now, opCompanyId),
          area('Main Road', now, opCompanyId)
        ])
      } else if (opCompanyId) {
        const noCompanyAreas = await db.areas.filter((a) => !a.companyId).toArray()
        for (const a of noCompanyAreas) {
          await db.areas.update(a.id, { companyId: opCompanyId, updatedAt: now, syncStatus: 'pending' })
        }
      }

      // Operator "test1" with access to every machine.
      let test1 = await db.operators.filter((o) => (o.name || '').toLowerCase() === 'test1').first()
      if (!test1) {
        const allMachineIds = (await db.machines.toArray()).map((m) => m.id)
        test1 = {
          id: uuid(),
          name: 'test1',
          pin: '1234', // stored plain so admin can view it
          pinHash: demoPin, // demo PIN: 1234
          active: true,
          companyId: opCompanyId,
          machineIds: allMachineIds,
          updatedAt: now,
          syncStatus: 'pending'
        }
        await db.operators.add(test1)
      }
      // Make the demo operator's PIN viewable on already-installed devices.
      if (test1 && !test1.pin) {
        await db.operators.update(test1.id, { pin: '1234', updatedAt: now, syncStatus: 'pending' })
      }

      // Ensure every operator belongs to a company (assign the first one).
      if (opCompanyId) {
        const noCompanyOps = await db.operators.filter((o) => !o.companyId).toArray()
        for (const o of noCompanyOps) {
          await db.operators.update(o.id, { companyId: opCompanyId, updatedAt: now, syncStatus: 'pending' })
        }
      }

      // Migrate existing tasks that have no operator onto test1.
      const orphanTasks = await db.tasks.filter((t) => !t.operatorId).toArray()
      for (const t of orphanTasks) {
        await db.tasks.update(t.id, {
          operatorId: test1.id,
          operatorName: test1.name,
          updatedAt: now,
          syncStatus: 'pending'
        })
      }

      if ((await getMeta('currency')) == null) await setMeta('currency', 'RM')
      await setMeta('seeded.v7', true)
    }
  )
}

function prate(name, unit, price, machineId, now) {
  return { id: uuid(), machineId, name, unit, price, active: true, updatedAt: now, syncStatus: 'pending' }
}

function area(name, now, companyId) {
  return { id: uuid(), companyId: companyId ?? null, name, active: true, updatedAt: now, syncStatus: 'pending' }
}

export default db
