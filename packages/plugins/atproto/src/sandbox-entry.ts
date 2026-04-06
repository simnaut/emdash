/**
 * Sandbox Entry Point -- AT Protocol
 *
 * Canonical plugin implementation using the standard format.
 * The bundler (tsdown) inlines all local imports from atproto.ts,
 * bluesky.ts, and standard-site.ts into a single self-contained file.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import {
	ensureSession,
	createRecord,
	putRecord,
	deleteRecord,
	rkeyFromUri,
	uploadBlob,
	requireHttp,
} from "./atproto.js";
import { buildBskyPost } from "./bluesky.js";
import { bootstrap } from "./canonical/bootstrap.js";
import { emDashToPds } from "./canonical/record-mapper.js";
import { incrementalSync } from "./canonical/sync.js";
import { buildPublication, buildDocument } from "./standard-site.js";

// ── Types ───────────────────────────────────────────────────────

interface SyndicationRecord {
	collection: string;
	contentId: string;
	atUri: string;
	atCid: string;
	bskyPostUri?: string;
	bskyPostCid?: string;
	publishedAt: string;
	lastSyncedAt: string;
	status: "synced" | "error" | "pending";
	errorMessage?: string;
	retryCount?: number;
}

// ── Helpers ─────────────────────────────────────────────────────

type PluginMode = "metadata" | "canonical";

async function getMode(ctx: PluginContext): Promise<PluginMode> {
	const mode = await ctx.kv.get<string>("settings:mode");
	return mode === "canonical" ? "canonical" : "metadata";
}

async function isCollectionAllowed(ctx: PluginContext, collection: string): Promise<boolean> {
	const setting = await ctx.kv.get<string>("settings:collections");
	if (!setting || setting.trim() === "") return true;
	const allowed = setting.split(",").map((s) => s.trim().toLowerCase());
	return allowed.includes(collection.toLowerCase());
}

async function syndicateContent(
	ctx: PluginContext,
	collection: string,
	contentId: string,
	content: Record<string, unknown>,
): Promise<void> {
	const storageKey = `${collection}:${contentId}`;
	const existing = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;

	if (existing && existing.status === "synced") {
		const syncOnUpdate = (await ctx.kv.get<boolean>("settings:syncOnUpdate")) ?? true;
		if (!syncOnUpdate) return;
	}

	const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
	if (!siteUrl) throw new Error("Site URL not configured");

	const publicationUri = await ctx.kv.get<string>("state:publicationUri");
	if (!publicationUri)
		throw new Error("Publication record not created yet. Use Sync Publication first.");

	const { accessJwt, did, pdsHost } = await ensureSession(ctx);

	// Upload cover image if present
	let coverImageBlob;
	const rawCoverImage = content.cover_image as string | undefined;
	if (rawCoverImage) {
		let imageUrl = rawCoverImage;
		if (imageUrl.startsWith("/")) imageUrl = `${siteUrl}${imageUrl}`;

		if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
			try {
				const http = requireHttp(ctx);
				const imageRes = await http.fetch(imageUrl);
				if (imageRes.ok) {
					const bytes = await imageRes.arrayBuffer();
					if (bytes.byteLength <= 1_000_000) {
						const mimeType = imageRes.headers.get("content-type") || "image/jpeg";
						coverImageBlob = await uploadBlob(ctx, pdsHost, accessJwt, bytes, mimeType);
					}
				}
			} catch (error) {
				ctx.log.warn("Failed to upload cover image, skipping", error);
			}
		}
	}

	let bskyPostRef: { uri: string; cid: string } | undefined;

	if (existing && existing.atUri) {
		const rkey = rkeyFromUri(existing.atUri);
		const doc = buildDocument({
			publicationUri,
			content,
			coverImageBlob,
			bskyPostRef:
				existing.bskyPostUri && existing.bskyPostCid
					? { uri: existing.bskyPostUri, cid: existing.bskyPostCid }
					: undefined,
		});

		const result = await putRecord(
			ctx,
			pdsHost,
			accessJwt,
			did,
			"site.standard.document",
			rkey,
			doc,
		);

		await ctx.storage.records!.put(storageKey, {
			collection: existing.collection,
			contentId: existing.contentId,
			atUri: result.uri,
			atCid: result.cid,
			bskyPostUri: existing.bskyPostUri,
			bskyPostCid: existing.bskyPostCid,
			publishedAt: existing.publishedAt,
			lastSyncedAt: new Date().toISOString(),
			status: "synced",
			retryCount: 0,
		} satisfies SyndicationRecord);

		ctx.log.info(`Updated AT Protocol document for ${collection}/${contentId}`);
	} else {
		const doc = buildDocument({ publicationUri, content, coverImageBlob });
		const result = await createRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", doc);

		const enableCrosspost = (await ctx.kv.get<boolean>("settings:enableBskyCrosspost")) ?? true;
		if (enableCrosspost) {
			try {
				const template =
					(await ctx.kv.get<string>("settings:crosspostTemplate")) || "{title}\n\n{url}";
				const langsStr = (await ctx.kv.get<string>("settings:langs")) || "en";
				const langs = langsStr
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
					.slice(0, 3);
				const post = buildBskyPost({
					template,
					content,
					siteUrl,
					thumbBlob: coverImageBlob,
					langs,
				});

				const postResult = await createRecord(
					ctx,
					pdsHost,
					accessJwt,
					did,
					"app.bsky.feed.post",
					post,
				);
				bskyPostRef = { uri: postResult.uri, cid: postResult.cid };

				const rkey = rkeyFromUri(result.uri);
				const updatedDoc = buildDocument({ publicationUri, content, coverImageBlob, bskyPostRef });
				await putRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", rkey, updatedDoc);

				ctx.log.info(`Cross-posted ${collection}/${contentId} to Bluesky`);
			} catch (error) {
				ctx.log.warn("Failed to cross-post to Bluesky, document still synced", error);
			}
		}

		await ctx.storage.records!.put(storageKey, {
			collection,
			contentId,
			atUri: result.uri,
			atCid: result.cid,
			bskyPostUri: bskyPostRef?.uri,
			bskyPostCid: bskyPostRef?.cid,
			publishedAt: (content.published_at as string) || new Date().toISOString(),
			lastSyncedAt: new Date().toISOString(),
			status: "synced",
		} satisfies SyndicationRecord);

		ctx.log.info(`Created AT Protocol document for ${collection}/${contentId}`);
	}
}

// ── Plugin definition ───────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": async (_event: unknown, ctx: PluginContext) => {
			ctx.log.info("AT Protocol plugin installed");
		},

		"content:afterSave": {
			handler: async (
				event: { content: Record<string, unknown>; collection: string; isNew: boolean },
				ctx: PluginContext,
			) => {
				// In canonical mode, publishing is handled by content:beforePublish
				if ((await getMode(ctx)) === "canonical") return;

				const { content, collection } = event;
				const contentId = typeof content.id === "string" ? content.id : String(content.id);
				const status = content.status as string | undefined;

				if (status !== "published") return;
				if (!(await isCollectionAllowed(ctx, collection))) return;

				try {
					await syndicateContent(ctx, collection, contentId, content);
				} catch (error) {
					ctx.log.error(`Failed to syndicate ${collection}/${contentId}`, error);

					const storageKey = `${collection}:${contentId}`;
					const existing = await ctx.storage.records!.get(storageKey);
					const record = (existing as SyndicationRecord | null) || {
						collection,
						contentId,
						atUri: "",
						atCid: "",
						publishedAt: new Date().toISOString(),
					};

					await ctx.storage.records!.put(storageKey, {
						...record,
						status: "error",
						lastSyncedAt: new Date().toISOString(),
						errorMessage: error instanceof Error ? error.message : String(error),
						retryCount: ((record as SyndicationRecord).retryCount || 0) + 1,
					});
				}
			},
		},

		"content:afterDelete": {
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				const { id, collection } = event;
				const deleteOnUnpublish = (await ctx.kv.get<boolean>("settings:deleteOnUnpublish")) ?? true;
				if (!deleteOnUnpublish) return;

				const storageKey = `${collection}:${id}`;
				const existing = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;
				if (!existing || !existing.atUri) return;

				try {
					const { accessJwt, did, pdsHost } = await ensureSession(ctx);
					const rkey = rkeyFromUri(existing.atUri);
					await deleteRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", rkey);

					if (existing.bskyPostUri) {
						const postRkey = rkeyFromUri(existing.bskyPostUri);
						await deleteRecord(ctx, pdsHost, accessJwt, did, "app.bsky.feed.post", postRkey);
					}

					await ctx.storage.records!.delete(storageKey);
					ctx.log.info(`Deleted AT Protocol records for ${collection}/${id}`);
				} catch (error) {
					ctx.log.error(`Failed to delete AT Protocol records for ${collection}/${id}`, error);
				}
			},
		},

		// ── Canonical mode hooks ────────────────────────────────────

		"content:beforePublish": {
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				if ((await getMode(ctx)) !== "canonical") return;
				if (!(await isCollectionAllowed(ctx, event.collection))) return;
				if (!ctx.content) throw new Error("Canonical mode requires write:content capability");

				const contentItem = await ctx.content.get(event.collection, event.id);
				if (!contentItem) throw new Error(`Content ${event.collection}/${event.id} not found`);

				const contentRecord = { ...contentItem.data, id: contentItem.id } as Record<
					string,
					unknown
				>;
				const publicationUri = await ctx.kv.get<string>("state:publicationUri");
				if (!publicationUri) {
					throw new Error("Publication record not created yet. Use Sync Publication first.");
				}

				const { accessJwt, did, pdsHost } = await ensureSession(ctx);

				// Upload cover image if present
				let coverImageBlob;
				const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
				const rawCoverImage = contentRecord.cover_image as string | undefined;
				if (rawCoverImage && siteUrl) {
					let imageUrl = rawCoverImage;
					if (imageUrl.startsWith("/")) imageUrl = `${siteUrl}${imageUrl}`;
					if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
						try {
							const http = requireHttp(ctx);
							const imageRes = await http.fetch(imageUrl);
							if (imageRes.ok) {
								const bytes = await imageRes.arrayBuffer();
								if (bytes.byteLength <= 1_000_000) {
									const mimeType = imageRes.headers.get("content-type") || "image/jpeg";
									coverImageBlob = await uploadBlob(ctx, pdsHost, accessJwt, bytes, mimeType);
								}
							}
						} catch (error) {
							ctx.log.warn("Failed to upload cover image, skipping", error);
						}
					}
				}

				// Build the PDS record using the canonical mapper
				const doc = emDashToPds(contentRecord, event.collection, publicationUri, coverImageBlob);

				// Check if we already have a PDS record for this content
				const storageKey = `${event.collection}:${event.id}`;
				const existing = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;

				let result;
				if (existing?.atUri) {
					// Update existing PDS record
					const rkey = rkeyFromUri(existing.atUri);
					result = await putRecord(
						ctx,
						pdsHost,
						accessJwt,
						did,
						"site.standard.document",
						rkey,
						doc,
					);
				} else {
					// Create new PDS record
					result = await createRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", doc);
				}

				// Track in records storage
				await ctx.storage.records!.put(storageKey, {
					collection: event.collection,
					contentId: event.id,
					atUri: result.uri,
					atCid: result.cid,
					bskyPostUri: existing?.bskyPostUri,
					bskyPostCid: existing?.bskyPostCid,
					publishedAt: (contentRecord.published_at as string) || new Date().toISOString(),
					lastSyncedAt: new Date().toISOString(),
					status: "synced",
				} satisfies SyndicationRecord);

				// Track in pdsIndex for sync
				const pdsIndex = (
					ctx.storage as unknown as Record<
						string,
						{ put(key: string, data: unknown): Promise<void> } | undefined
					>
				).pdsIndex;
				if (pdsIndex) {
					const rkey = rkeyFromUri(result.uri);
					await pdsIndex.put(rkey, {
						rkey,
						contentId: event.id,
						collection: event.collection,
						atUri: result.uri,
						atCid: result.cid,
						origin: "emdash",
						importedAt: new Date().toISOString(),
					});
				}

				ctx.log.info(
					`PDS record ${existing?.atUri ? "updated" : "created"} for ${event.collection}/${event.id}`,
				);
			},
			errorPolicy: "abort",
		},

		"content:afterPublish": {
			handler: async (
				event: { content: Record<string, unknown>; collection: string },
				ctx: PluginContext,
			) => {
				if ((await getMode(ctx)) !== "canonical") return;

				const enableCrosspost = (await ctx.kv.get<boolean>("settings:enableBskyCrosspost")) ?? true;
				if (!enableCrosspost) return;

				const storageKey = `${event.collection}:${typeof event.content.id === "string" ? event.content.id : String(event.content.id)}`;
				const record = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;
				if (!record?.atUri || record.bskyPostUri) return; // Already crossposted or no PDS record

				try {
					const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
					if (!siteUrl) return;

					const { accessJwt, did, pdsHost } = await ensureSession(ctx);
					const template =
						(await ctx.kv.get<string>("settings:crosspostTemplate")) || "{title}\n\n{url}";
					const langsStr = (await ctx.kv.get<string>("settings:langs")) || "en";
					const langs = langsStr
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
						.slice(0, 3);

					const post = buildBskyPost({
						template,
						content: event.content,
						siteUrl,
						langs,
					});

					const postResult = await createRecord(
						ctx,
						pdsHost,
						accessJwt,
						did,
						"app.bsky.feed.post",
						post,
					);

					// Update the document with bskyPostRef
					const publicationUri = await ctx.kv.get<string>("state:publicationUri");
					if (publicationUri) {
						const rkey = rkeyFromUri(record.atUri);
						const doc = emDashToPds(event.content, event.collection, publicationUri);
						doc.bskyPostRef = { uri: postResult.uri, cid: postResult.cid };
						await putRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", rkey, doc);
					}

					// Update storage with crosspost info
					await ctx.storage.records!.put(storageKey, {
						...record,
						bskyPostUri: postResult.uri,
						bskyPostCid: postResult.cid,
						lastSyncedAt: new Date().toISOString(),
					});

					ctx.log.info(`Cross-posted to Bluesky for ${event.collection}`);
				} catch (error) {
					ctx.log.warn("Failed to cross-post to Bluesky", error);
				}
			},
		},

		"content:beforeUnpublish": {
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				if ((await getMode(ctx)) !== "canonical") return;

				const storageKey = `${event.collection}:${event.id}`;
				const existing = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;
				if (!existing?.atUri) return;

				const { accessJwt, did, pdsHost } = await ensureSession(ctx);
				const rkey = rkeyFromUri(existing.atUri);
				await deleteRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", rkey);

				// Delete Bluesky crosspost if present
				if (existing.bskyPostUri) {
					try {
						const postRkey = rkeyFromUri(existing.bskyPostUri);
						await deleteRecord(ctx, pdsHost, accessJwt, did, "app.bsky.feed.post", postRkey);
					} catch (error) {
						ctx.log.warn("Failed to delete Bluesky crosspost", error);
					}
				}

				// Clean up storage
				await ctx.storage.records!.delete(storageKey);

				// Clean up pdsIndex
				const pdsIndex = (
					ctx.storage as unknown as Record<
						string,
						{ delete(key: string): Promise<void> } | undefined
					>
				).pdsIndex;
				if (pdsIndex) {
					await pdsIndex.delete(rkey);
				}

				ctx.log.info(`Deleted PDS record for ${event.collection}/${event.id}`);
			},
			errorPolicy: "abort",
		},

		"page:metadata": async (
			event: { page: { content?: { collection: string; id: string } } },
			ctx: PluginContext,
		) => {
			const pageContent = event.page.content;
			if (!pageContent) return null;

			const storageKey = `${pageContent.collection}:${pageContent.id}`;
			const record = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;

			if (!record || !record.atUri || record.status !== "synced") return null;

			return {
				kind: "link" as const,
				rel: "site.standard.document",
				href: record.atUri,
				key: "atproto-document",
			};
		},
	},

	routes: {
		status: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					const handle = await ctx.kv.get<string>("settings:handle");
					const did = await ctx.kv.get<string>("state:did");
					const pubUri = await ctx.kv.get<string>("state:publicationUri");
					const synced = await ctx.storage.records!.count({
						status: "synced",
					});
					const errors = await ctx.storage.records!.count({
						status: "error",
					});
					const pending = await ctx.storage.records!.count({
						status: "pending",
					});

					return {
						configured: !!handle,
						connected: !!did,
						handle: handle || null,
						did: did || null,
						publicationUri: pubUri || null,
						stats: { synced, errors, pending },
					};
				} catch (error) {
					ctx.log.error("Failed to get status", error);
					return {
						configured: false,
						connected: false,
						handle: null,
						did: null,
						publicationUri: null,
						stats: { synced: 0, errors: 0, pending: 0 },
					};
				}
			},
		},

		"test-connection": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					const session = await ensureSession(ctx);
					return {
						success: true,
						did: session.did,
						pdsHost: session.pdsHost,
					};
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},

		"sync-publication": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
					const siteName = await ctx.kv.get<string>("settings:siteName");
					if (!siteUrl || !siteName)
						return {
							success: false,
							error: "Site URL and name are required",
						};

					const { accessJwt, did, pdsHost } = await ensureSession(ctx);
					const publication = buildPublication(siteUrl, siteName);
					const existingUri = await ctx.kv.get<string>("state:publicationUri");

					let result;
					if (existingUri) {
						const rkey = rkeyFromUri(existingUri);
						result = await putRecord(
							ctx,
							pdsHost,
							accessJwt,
							did,
							"site.standard.publication",
							rkey,
							publication,
						);
					} else {
						result = await createRecord(
							ctx,
							pdsHost,
							accessJwt,
							did,
							"site.standard.publication",
							publication,
						);
					}

					await ctx.kv.set("state:publicationUri", result.uri);
					await ctx.kv.set("state:publicationCid", result.cid);
					return {
						success: true,
						uri: result.uri,
						cid: result.cid,
					};
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},

		"recent-syncs": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					const result = await ctx.storage.records!.query({
						orderBy: { lastSyncedAt: "desc" },
						limit: 20,
					});
					return {
						items: result.items.map((item: { id: string; data: unknown }) => ({
							id: item.id,
							...(item.data as SyndicationRecord),
						})),
					};
				} catch (error) {
					ctx.log.error("Failed to get recent syncs", error);
					return { items: [] };
				}
			},
		},

		verification: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const pubUri = await ctx.kv.get<string>("state:publicationUri");
				const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
				return {
					publicationUri: pubUri || null,
					siteUrl: siteUrl || null,
					wellKnownPath: "/.well-known/site.standard.publication",
					wellKnownContent: pubUri || "(not configured yet)",
				};
			},
		},

		// ── Canonical mode routes ───────────────────────────────────

		bootstrap: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				if ((await getMode(ctx)) !== "canonical") {
					return { success: false, error: "Bootstrap is only available in canonical mode" };
				}

				try {
					const importCollections = await ctx.kv.get<string>("settings:importCollections");
					const additionalCollections = importCollections
						? importCollections
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
						: undefined;

					const result = await bootstrap(ctx, {
						additionalCollections,
					});

					return { success: true, ...result };
				} catch (error) {
					ctx.log.error("Bootstrap failed", error);
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},

		sync: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				if ((await getMode(ctx)) !== "canonical") {
					return { success: false, error: "Sync is only available in canonical mode" };
				}

				try {
					const importCollections = await ctx.kv.get<string>("settings:importCollections");
					const additionalCollections = importCollections
						? importCollections
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
						: undefined;

					const result = await incrementalSync(ctx, {
						additionalCollections,
					});

					return { success: true, ...result };
				} catch (error) {
					ctx.log.error("Sync failed", error);
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},

		admin: {
			handler: async (routeCtx: any, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" && interaction.page === "widget:sync-status") {
					return buildSyncWidget(ctx);
				}
				if (interaction.type === "page_load" && interaction.page === "/status") {
					return buildStatusPage(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}
				if (interaction.type === "block_action" && interaction.action_id === "test_connection") {
					return testConnection(ctx);
				}
				if (interaction.type === "block_action" && interaction.action_id === "run_bootstrap") {
					return runBootstrap(ctx);
				}
				if (interaction.type === "block_action" && interaction.action_id === "run_sync") {
					return runSync(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});

// ── Block Kit admin helpers ─────────────────────────────────────

async function buildSyncWidget(ctx: PluginContext) {
	try {
		const handle = await ctx.kv.get<string>("settings:handle");
		const did = await ctx.kv.get<string>("state:did");
		const synced = await ctx.storage.records!.count({ status: "synced" });
		const errors = await ctx.storage.records!.count({ status: "error" });

		if (!handle) {
			return {
				blocks: [
					{ type: "context", text: "Not configured -- set your handle in AT Protocol settings." },
				],
			};
		}

		return {
			blocks: [
				{
					type: "fields",
					fields: [
						{ label: "Handle", value: `@${handle}` },
						{ label: "Status", value: did ? "Connected" : "Not connected" },
						{ label: "Synced", value: String(synced) },
						{ label: "Errors", value: String(errors) },
					],
				},
			],
		};
	} catch (error) {
		ctx.log.error("Failed to build sync widget", error);
		return { blocks: [{ type: "context", text: "Failed to load status" }] };
	}
}

async function buildStatusPage(ctx: PluginContext) {
	try {
		const handle = await ctx.kv.get<string>("settings:handle");
		const appPassword = await ctx.kv.get<string>("settings:appPassword");
		const pdsHost = await ctx.kv.get<string>("settings:pdsHost");
		const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
		const enableCrosspost = await ctx.kv.get<boolean>("settings:enableCrosspost");
		const mode = await getMode(ctx);
		const importCollections = await ctx.kv.get<string>("settings:importCollections");
		const did = await ctx.kv.get<string>("state:did");
		const pubUri = await ctx.kv.get<string>("state:publicationUri");

		const blocks: unknown[] = [
			{ type: "header", text: "AT Protocol" },
			{
				type: "section",
				text: "Syndicate content to the AT Protocol network (Bluesky, standard.site).",
			},
			{ type: "divider" },
		];

		if (did) {
			blocks.push({
				type: "banner",
				style: "success",
				text: `Connected as ${handle} (${did})`,
			});
		} else if (handle) {
			blocks.push({
				type: "banner",
				style: "warning",
				text: "Handle configured but not yet connected. Save settings and test the connection.",
			});
		}

		blocks.push({
			type: "form",
			block_id: "atproto-settings",
			fields: [
				{
					type: "text_input",
					action_id: "handle",
					label: "AT Protocol Handle",
					initial_value: handle ?? "",
				},
				{ type: "secret_input", action_id: "appPassword", label: "App Password" },
				{
					type: "text_input",
					action_id: "pdsHost",
					label: "PDS Host",
					initial_value: pdsHost ?? "https://bsky.social",
				},
				{
					type: "text_input",
					action_id: "siteUrl",
					label: "Site URL",
					initial_value: siteUrl ?? "",
				},
				{
					type: "select",
					action_id: "mode",
					label: "Mode",
					initial_value: mode,
					options: [
						{
							label: "Metadata — create standard.site records on publish (one-way)",
							value: "metadata",
						},
						{
							label: "Canonical — PDS is source of truth, EmDash is a cache",
							value: "canonical",
						},
					],
				},
				{
					type: "toggle",
					action_id: "enableCrosspost",
					label: "Cross-post to Bluesky",
					initial_value: enableCrosspost ?? false,
				},
				...(mode === "canonical"
					? [
							{
								type: "text_input",
								action_id: "importCollections",
								label: "Additional PDS Collections (comma-separated)",
								initial_value: importCollections ?? "",
								placeholder: "com.whtwnd.blog.entry",
							},
						]
					: []),
			],
			submit: { label: "Save Settings", action_id: "save_settings" },
		});

		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: "Test Connection",
					action_id: "test_connection",
					style: handle && appPassword ? "primary" : undefined,
				},
			],
		});

		// Canonical mode controls
		if (mode === "canonical" && did) {
			const lastSync = await ctx.kv.get<string>("canonical:lastSync");
			const lastBootstrap = await ctx.kv.get<string>("canonical:lastBootstrap");
			const recordCount = await ctx.kv.get<string>("canonical:recordCount");

			blocks.push(
				{ type: "divider" },
				{ type: "header", text: "PDS Canonical Mode" },
				{
					type: "section",
					text: "PDS is the source of truth. Content is loaded from PDS records. Publishes write to PDS first.",
				},
			);

			if (lastBootstrap || lastSync) {
				blocks.push({
					type: "fields",
					fields: [
						...(lastBootstrap ? [{ label: "Last Bootstrap", value: lastBootstrap }] : []),
						...(lastSync ? [{ label: "Last Sync", value: lastSync }] : []),
						...(recordCount ? [{ label: "PDS Records", value: recordCount }] : []),
					],
				});
			}

			blocks.push({
				type: "actions",
				elements: [
					{
						type: "button",
						text: "Sync from PDS",
						action_id: "run_bootstrap",
						style: "primary",
					},
					{
						type: "button",
						text: "Incremental Sync",
						action_id: "run_sync",
					},
				],
			});
		}

		if (did) {
			const result = await ctx.storage.records!.query({
				orderBy: { lastSyncedAt: "desc" },
				limit: 10,
			});
			const items = result.items.map((item: { id: string; data: unknown }) => ({
				id: item.id,
				...(item.data as SyndicationRecord),
			}));

			if (items.length > 0) {
				blocks.push(
					{ type: "divider" },
					{ type: "header", text: "Recent Syncs" },
					{
						type: "table",
						columns: [
							{ key: "collection", label: "Collection", format: "text" },
							{ key: "contentId", label: "Content", format: "code" },
							{ key: "status", label: "Status", format: "badge" },
							{ key: "lastSyncedAt", label: "Synced", format: "relative_time" },
						],
						rows: items.map((r) => ({
							collection: r.collection,
							contentId: r.contentId,
							status: r.status,
							lastSyncedAt: r.lastSyncedAt,
						})),
						emptyText: "No syncs yet",
					},
				);
			}

			if (pubUri) {
				blocks.push(
					{ type: "divider" },
					{ type: "header", text: "Verification" },
					{
						type: "fields",
						fields: [
							{ label: "Publication URI", value: pubUri },
							{ label: "Well-known path", value: "/.well-known/site.standard.publication" },
						],
					},
					{
						type: "context",
						text: "Add this path to your site to verify ownership on the AT Protocol network.",
					},
				);
			}
		}

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build status page", error);
		return { blocks: [{ type: "banner", style: "error", text: "Failed to load settings" }] };
	}
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	try {
		if (typeof values.handle === "string") await ctx.kv.set("settings:handle", values.handle);
		if (typeof values.appPassword === "string" && values.appPassword)
			await ctx.kv.set("settings:appPassword", values.appPassword);
		if (typeof values.pdsHost === "string") await ctx.kv.set("settings:pdsHost", values.pdsHost);
		if (typeof values.siteUrl === "string") await ctx.kv.set("settings:siteUrl", values.siteUrl);
		if (
			typeof values.mode === "string" &&
			(values.mode === "metadata" || values.mode === "canonical")
		)
			await ctx.kv.set("settings:mode", values.mode);
		if (typeof values.enableCrosspost === "boolean")
			await ctx.kv.set("settings:enableCrosspost", values.enableCrosspost);
		if (typeof values.importCollections === "string")
			await ctx.kv.set("settings:importCollections", values.importCollections);

		const page = await buildStatusPage(ctx);
		return { ...page, toast: { message: "Settings saved", type: "success" } };
	} catch (error) {
		ctx.log.error("Failed to save settings", error);
		return {
			blocks: [{ type: "banner", style: "error", text: "Failed to save settings" }],
			toast: { message: "Failed to save settings", type: "error" },
		};
	}
}

async function testConnection(ctx: PluginContext) {
	try {
		const session = await ensureSession(ctx);
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: { message: `Connected to ${session.pdsHost} as ${session.did}`, type: "success" },
		};
	} catch (error) {
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: {
				message: `Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				type: "error",
			},
		};
	}
}

async function runBootstrap(ctx: PluginContext) {
	try {
		const importCollections = await ctx.kv.get<string>("settings:importCollections");
		const additionalCollections = importCollections
			? importCollections
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined;

		const result = await bootstrap(ctx, { additionalCollections });
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: {
				message: `Bootstrap complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`,
				type: result.errors > 0 ? "warning" : "success",
			},
		};
	} catch (error) {
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: {
				message: `Bootstrap failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				type: "error",
			},
		};
	}
}

async function runSync(ctx: PluginContext) {
	try {
		const importCollections = await ctx.kv.get<string>("settings:importCollections");
		const additionalCollections = importCollections
			? importCollections
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined;

		const result = await incrementalSync(ctx, { additionalCollections });
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: {
				message: `Sync complete: +${result.created} ~${result.updated} -${result.deleted} =${result.unchanged}`,
				type: result.errors > 0 ? "warning" : "success",
			},
		};
	} catch (error) {
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: {
				message: `Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				type: "error",
			},
		};
	}
}
