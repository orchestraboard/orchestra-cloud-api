import { describe, it, expect } from 'vitest'
import { mintDeviceToken, verifyDeviceToken, revokeDevice } from '../src/hub/devices.js'
import { hubTestSql, seedOrg } from './support/hub-sql.js'

describe('hub device tokens', () => {
  it('mints a verifiable token and never stores it in plaintext', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')

    const { device, token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })
    expect(token).toMatch(/^orchestra_device_v1\./)

    const stored = await sql.query<{ token_hash: string }>('SELECT token_hash FROM devices WHERE id = $1', [device.id])
    expect(stored.rows[0].token_hash).not.toContain(token)

    const verified = await verifyDeviceToken(sql, token)
    expect(verified.id).toBe(device.id)
    expect(verified.org_id).toBe('org_a')
  })

  it('rejects an unknown token', async () => {
    const sql = await hubTestSql()
    await expect(verifyDeviceToken(sql, 'orchestra_device_v1.nonsense')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a revoked token', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    const { device, token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })

    await revokeDevice(sql, 'org_a', device.id)
    await expect(verifyDeviceToken(sql, token)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('will not revoke a device belonging to another org', async () => {
    const sql = await hubTestSql()
    await seedOrg(sql, 'org_a')
    await seedOrg(sql, 'org_b')
    const { device, token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'laptop' })

    await expect(revokeDevice(sql, 'org_b', device.id)).rejects.toMatchObject({ statusCode: 404 })
    await expect(verifyDeviceToken(sql, token)).resolves.toMatchObject({ id: device.id })
  })
})
