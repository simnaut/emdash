/**
 * Incremental sync: Detect changes on PDS and update the local SQLite cache.
 *
 * Compares CIDs from PDS records against what's stored in the pdsIndex.
 * New records are imported, changed records are updated, and deleted
 * records are removed from EmDash.
 */

import type { PluginContext } from "emdash";

import { ensureSession, listRecords, rkeyFromUri, type ListRecordsResponse } from "../atproto.js";
import { pdsToEmDash } from "./record-mapper.js";

const BATCH_SIZE = 100;

export interface SyncResult {
	created: number;
	updated: number;
	deleted: number;
	unchanged: number;
	errors: number;
}

interface PdsIndexEntry {
	rkey: string;
	contentId: string;
	collection: string;
	atUri: string;
	atCid: string;
	origin: string;
	importedAt: string;
}

/**
 * Run an incremental sync from PDS to EmDash.
 *
 * Compares all PDS records against the local pdsIndex:
 * - New records → import
 * - Changed CIDs → update
 * - Missing records (in index but not on PDS) → delete
 */
export async function incrementalSync(
	ctx: PluginContext,
	opts?: {
		defaultCollection?: string;
		additionalCollections?: string[];
	},
): Promise<SyncResult> {
	if (!ctx.content) {
		throw new Error("Sync requires write:content capability");
	}

	const session = await ensureSession(ctx);
	const defaultCollection = opts?.defaultCollection || "posts";
	const result: SyncResult = {
		created: 0,
		updated: 0,
		deleted: 0,
		unchanged: 0,
		errors: 0,
	};

	// Collect all PDS records
	const pdsRecords = new Map<string, { uri: string; cid: string; value: unknown }>();
	await collectRecords(
		ctx,
		session.pdsHost,
		session.accessJwt,
		session.did,
		"site.standard.document",
		pdsRecords,
	);

	if (opts?.additionalCollections) {
		for (const collection of opts.additionalCollections) {
			await collectRecords(
				ctx,
				session.pdsHost,
				session.accessJwt,
				session.did,
				collection,
				pdsRecords,
			);
		}
	}

	// Get all known records from pdsIndex
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- plugin storage returns unknown
	const pdsIndex = (
		ctx.storage as unknown as Record<
			string,
			{
				query(opts: Record<string, unknown>): Promise<{ items: unknown[] }>;
				put(key: string, data: unknown): Promise<void>;
				delete(key: string): Promise<void>;
			}
		>
	).pdsIndex;
	if (!pdsIndex) {
		ctx.log.error("pdsIndex storage collection not available");
		return result;
	}

	const indexEntries = await pdsIndex.query({ limit: 10000 });
	const knownRkeys = new Map<string, PdsIndexEntry>();
	for (const item of indexEntries.items) {
		const entry = item as PdsIndexEntry;
		if (entry.rkey) {
			knownRkeys.set(entry.rkey, entry);
		}
	}

	// Process PDS records
	for (const [rkey, record] of pdsRecords) {
		const existing = knownRkeys.get(rkey);

		if (!existing) {
			// New record — import
			try {
				const imported = pdsToEmDash(record.value, "site.standard.document", defaultCollection);
				const created = await ctx.content!.create!(imported.collection, imported.data);
				const createdId = created?.id;

				await pdsIndex.put(rkey, {
					rkey,
					contentId: createdId,
					collection: imported.collection,
					atUri: record.uri,
					atCid: record.cid,
					origin: imported.origin,
					importedAt: new Date().toISOString(),
				});
				result.created++;
			} catch (error) {
				ctx.log.error(`Failed to import new record ${record.uri}:`, error);
				result.errors++;
			}
		} else if (existing.atCid !== record.cid) {
			// Changed record — update
			try {
				const imported = pdsToEmDash(record.value, "site.standard.document", defaultCollection);
				if (existing.contentId) {
					await ctx.content!.update!(existing.collection, existing.contentId, imported.data);
				}
				await pdsIndex.put(rkey, {
					...existing,
					atCid: record.cid,
					importedAt: new Date().toISOString(),
				});
				result.updated++;
			} catch (error) {
				ctx.log.error(`Failed to update record ${record.uri}:`, error);
				result.errors++;
			}
		} else {
			result.unchanged++;
		}

		// Remove from knownRkeys so we can find deletions
		knownRkeys.delete(rkey);
	}

	// Remaining knownRkeys are records that were deleted from PDS
	for (const [rkey, entry] of knownRkeys) {
		try {
			if (entry.contentId) {
				await ctx.content!.delete!(entry.collection, entry.contentId);
			}
			await pdsIndex.delete(rkey);
			result.deleted++;
		} catch (error) {
			ctx.log.error(`Failed to delete record for rkey ${rkey}:`, error);
			result.errors++;
		}
	}

	// Update sync metadata
	await ctx.kv.set("canonical:lastSync", new Date().toISOString());

	ctx.log.info(
		`Sync complete: +${result.created} ~${result.updated} -${result.deleted} =${result.unchanged} !${result.errors}`,
	);

	return result;
}

async function collectRecords(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	did: string,
	collection: string,
	target: Map<string, { uri: string; cid: string; value: unknown }>,
): Promise<void> {
	let cursor: string | undefined;

	do {
		let page: ListRecordsResponse;
		try {
			page = await listRecords(ctx, pdsHost, accessJwt, did, collection, {
				limit: BATCH_SIZE,
				cursor,
			});
		} catch (error) {
			ctx.log.error(`Failed to list records from ${collection}:`, error);
			return;
		}

		for (const record of page.records) {
			const rkey = rkeyFromUri(record.uri);
			target.set(rkey, record);
		}

		cursor = page.cursor;
	} while (cursor);
}
