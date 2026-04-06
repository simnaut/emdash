/**
 * Bootstrap: Import all published content from PDS into EmDash.
 *
 * Fetches all site.standard.document records (and optionally other collections)
 * from the user's PDS, maps them to EmDash content, and creates them via
 * the plugin content API.
 */

import type { PluginContext } from "emdash";

import { ensureSession, listRecords, rkeyFromUri, type ListRecordsResponse } from "../atproto.js";
import { pdsToEmDash } from "./record-mapper.js";

const BATCH_SIZE = 100;

export interface BootstrapResult {
	imported: number;
	skipped: number;
	errors: number;
	collections: Record<string, number>;
}

/**
 * Bootstrap content from PDS into EmDash.
 *
 * Fetches all records from PDS and creates them in EmDash via ctx.content.
 * Tracks imported records in the pdsIndex storage collection to avoid
 * duplicate imports on subsequent bootstraps.
 */
export async function bootstrap(
	ctx: PluginContext,
	opts?: {
		/** Default EmDash collection for non-EmDash records */
		defaultCollection?: string;
		/** Additional PDS collections to scan (e.g. "com.whtwnd.blog.entry") */
		additionalCollections?: string[];
	},
): Promise<BootstrapResult> {
	if (!ctx.content) {
		throw new Error("Bootstrap requires write:content capability");
	}

	const session = await ensureSession(ctx);
	const defaultCollection = opts?.defaultCollection || "posts";
	const result: BootstrapResult = {
		imported: 0,
		skipped: 0,
		errors: 0,
		collections: {},
	};

	// Scan site.standard.document collection
	await scanCollection(
		ctx,
		session.pdsHost,
		session.accessJwt,
		session.did,
		"site.standard.document",
		defaultCollection,
		result,
	);

	// Scan additional collections (e.g. WhiteWind)
	if (opts?.additionalCollections) {
		for (const collection of opts.additionalCollections) {
			await scanCollection(
				ctx,
				session.pdsHost,
				session.accessJwt,
				session.did,
				collection,
				defaultCollection,
				result,
			);
		}
	}

	// Store sync timestamp
	await ctx.kv.set("canonical:lastBootstrap", new Date().toISOString());
	await ctx.kv.set("canonical:recordCount", String(result.imported));

	ctx.log.info(
		`Bootstrap complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`,
	);

	return result;
}

async function scanCollection(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	did: string,
	pdsCollection: string,
	defaultCollection: string,
	result: BootstrapResult,
): Promise<void> {
	let cursor: string | undefined;

	do {
		let page: ListRecordsResponse;
		try {
			page = await listRecords(ctx, pdsHost, accessJwt, did, pdsCollection, {
				limit: BATCH_SIZE,
				cursor,
			});
		} catch (error) {
			ctx.log.error(`Failed to list records from ${pdsCollection}:`, error);
			result.errors++;
			return;
		}

		for (const record of page.records) {
			const rkey = rkeyFromUri(record.uri);

			// Check if already imported
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- plugin storage returns unknown
			const existing = await (
				ctx.storage as unknown as Record<string, { get(key: string): Promise<unknown> }>
			).pdsIndex?.get(rkey);
			if (existing) {
				result.skipped++;
				continue;
			}

			try {
				const imported = pdsToEmDash(record.value, pdsCollection, defaultCollection);

				// Create content in EmDash
				const created = await ctx.content!.create!(imported.collection, imported.data);
				const createdId = created?.id;

				// Track in pdsIndex
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- plugin storage returns unknown
				const pdsIndex = (
					ctx.storage as unknown as Record<
						string,
						{ put(key: string, data: unknown): Promise<void> }
					>
				).pdsIndex;
				if (pdsIndex) {
					await pdsIndex.put(rkey, {
						rkey,
						contentId: createdId,
						collection: imported.collection,
						atUri: record.uri,
						atCid: record.cid,
						origin: imported.origin,
						importedAt: new Date().toISOString(),
					});
				}

				result.imported++;
				result.collections[imported.collection] =
					(result.collections[imported.collection] || 0) + 1;
			} catch (error) {
				ctx.log.error(`Failed to import record ${record.uri}:`, error);
				result.errors++;
			}
		}

		cursor = page.cursor;
	} while (cursor);
}
