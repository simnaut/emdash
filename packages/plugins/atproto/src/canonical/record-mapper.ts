/**
 * Bidirectional mapping between EmDash content and PDS records.
 *
 * EmDash → PDS: Used when publishing content to PDS.
 * PDS → EmDash: Used when bootstrapping/syncing from PDS.
 */

import type { BlobRef } from "../atproto.js";
import { extractPlainText } from "../standard-site.js";
import { detectFormat, type ContentOrigin } from "./format-detect.js";

// ── Types ─────────────────────────────────────────��─────────────

/** EmDash's Portable Text content type for the standard.site content open union */
export interface EmDashPortableTextContent {
	$type: "cms.emdash.portableText";
	/** Portable Text block array */
	blocks: unknown[];
	/** Schema version for future migration */
	version: 1;
	/** EmDash-specific metadata */
	_emdash: {
		/** Which EmDash collection this belongs to (e.g. "posts", "pages") */
		collection: string;
		/** Custom field values that don't map to standard.site fields */
		fields: Record<string, unknown>;
	};
}

export interface StandardDocumentRecord {
	$type: "site.standard.document";
	site: string;
	title: string;
	publishedAt: string;
	path?: string;
	description?: string;
	textContent?: string;
	tags?: string[];
	updatedAt?: string;
	coverImage?: BlobRef;
	content?: EmDashPortableTextContent | Record<string, unknown>;
	bskyPostRef?: { uri: string; cid: string };
}

/** The result of mapping a PDS record to EmDash content */
export interface ImportedContent {
	/** Which EmDash collection to place this in */
	collection: string;
	/** The content data for ctx.content.create() */
	data: Record<string, unknown>;
	/** Origin tool that created this record */
	origin: ContentOrigin;
}

// Pre-compiled regexes
const LEADING_SLASH_RE = /^\//;
const HASH_PREFIX_RE = /^#/;

// ── Standard field names used for mapping ───────────────────────

const STANDARD_FIELD_NAMES = new Set([
	"title",
	"slug",
	"excerpt",
	"description",
	"body",
	"content",
	"text",
	"tags",
	"cover_image",
	"published_at",
	"updated_at",
	"status",
]);

// ── EmDash → PDS ────────────────────────────────────────────────

/**
 * Map EmDash content to a site.standard.document record for PDS storage.
 *
 * @param content - The EmDash content item (from ctx.content.get())
 * @param collection - The EmDash collection slug (e.g. "posts")
 * @param publicationUri - The AT-URI of the site.standard.publication record
 * @param coverImageBlob - Optional uploaded cover image blob reference
 */
export function emDashToPds(
	content: Record<string, unknown>,
	collection: string,
	publicationUri: string,
	coverImageBlob?: BlobRef,
): StandardDocumentRecord {
	const title =
		(typeof content.title === "string" && content.title) ||
		(typeof content.name === "string" && content.name) ||
		"Untitled";
	const slug = typeof content.slug === "string" ? content.slug : undefined;
	const description =
		typeof content.excerpt === "string"
			? content.excerpt
			: typeof content.description === "string"
				? content.description
				: undefined;
	const publishedAt =
		typeof content.published_at === "string" ? content.published_at : new Date().toISOString();
	const updatedAt = typeof content.updated_at === "string" ? content.updated_at : undefined;
	const tags = extractTagValues(content);

	// Build the record
	const doc: StandardDocumentRecord = {
		$type: "site.standard.document",
		site: publicationUri,
		title,
		publishedAt,
	};

	if (slug) doc.path = `/${slug}`;
	if (description) doc.description = description;
	if (updatedAt) doc.updatedAt = updatedAt;
	if (tags.length > 0) doc.tags = tags;
	if (coverImageBlob) doc.coverImage = coverImageBlob;

	// Extract plain text for interop with other tools
	const plainText = extractPlainText(content);
	if (plainText) doc.textContent = plainText;

	// Build the EmDash content union type with Portable Text
	const ptBlocks = extractPortableTextBlocks(content);
	const customFields = extractCustomFields(content);

	doc.content = {
		$type: "cms.emdash.portableText",
		blocks: ptBlocks,
		version: 1,
		_emdash: {
			collection,
			fields: customFields,
		},
	};

	return doc;
}

// ── PDS → EmDash ────────────────────────────────────────────────

/**
 * Map a PDS record to EmDash content for import into SQLite.
 *
 * @param value - The PDS record value
 * @param collection - The PDS collection NSID
 * @param defaultCollection - Default EmDash collection for non-EmDash records
 */
export function pdsToEmDash(
	value: unknown,
	pdsCollection: string,
	defaultCollection: string = "posts",
): ImportedContent {
	const { origin } = detectFormat(value, pdsCollection);

	if (origin === "whitewind") {
		return mapWhiteWindRecord(value as Record<string, unknown>, defaultCollection);
	}

	if (!value || typeof value !== "object") {
		return {
			collection: defaultCollection,
			data: {},
			origin: "unknown",
		};
	}

	const record = value as Record<string, unknown>;

	// EmDash record — full fidelity via content union
	if (origin === "emdash" && record.content && typeof record.content === "object") {
		return mapEmDashRecord(record, record.content as Record<string, unknown>);
	}

	// Leaflet or plain standard.site — use textContent as fallback
	return mapStandardSiteRecord(record, defaultCollection, origin);
}

// ── Internal mappers ────────────────────────────────────────────

function mapEmDashRecord(
	record: Record<string, unknown>,
	contentBlock: Record<string, unknown>,
): ImportedContent {
	const emdash = contentBlock._emdash as Record<string, unknown> | undefined;
	const collection = typeof emdash?.collection === "string" ? emdash.collection : "posts";
	const customFields =
		emdash?.fields && typeof emdash.fields === "object"
			? (emdash.fields as Record<string, unknown>)
			: {};
	const blocks = Array.isArray(contentBlock.blocks) ? contentBlock.blocks : [];

	const data: Record<string, unknown> = {
		title: record.title,
		slug: typeof record.path === "string" ? record.path.replace(LEADING_SLASH_RE, "") : undefined,
		status: "published",
		published_at: record.publishedAt,
		updated_at: record.updatedAt,
		...customFields,
	};

	// Store the Portable Text body
	if (blocks.length > 0) {
		data.body = blocks;
	}

	if (typeof record.description === "string") {
		data.excerpt = record.description;
	}
	if (Array.isArray(record.tags)) {
		data.tags = record.tags;
	}

	return { collection, data, origin: "emdash" };
}

function mapStandardSiteRecord(
	record: Record<string, unknown>,
	defaultCollection: string,
	origin: ContentOrigin,
): ImportedContent {
	const data: Record<string, unknown> = {
		title: typeof record.title === "string" ? record.title : "Untitled",
		slug: typeof record.path === "string" ? record.path.replace(LEADING_SLASH_RE, "") : undefined,
		status: "published",
		published_at:
			typeof record.publishedAt === "string" ? record.publishedAt : new Date().toISOString(),
		updated_at: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
	};

	// Use textContent as the body (plain text or markdown)
	if (typeof record.textContent === "string") {
		data.body = record.textContent;
	}

	if (typeof record.description === "string") {
		data.excerpt = record.description;
	}
	if (Array.isArray(record.tags)) {
		data.tags = record.tags;
	}

	return { collection: defaultCollection, data, origin };
}

function mapWhiteWindRecord(
	record: Record<string, unknown>,
	defaultCollection: string,
): ImportedContent {
	const data: Record<string, unknown> = {
		title: typeof record.title === "string" ? record.title : "Untitled",
		status: "published",
		published_at:
			typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
	};

	// WhiteWind stores markdown in the `content` field
	if (typeof record.content === "string") {
		data.body = record.content;
	}

	return { collection: defaultCollection, data, origin: "whitewind" };
}

// ── Helpers ─────────────────────────────────────────────────────

function extractTagValues(content: Record<string, unknown>): string[] {
	const raw = content.tags;
	if (!Array.isArray(raw)) return [];

	const tags: string[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			tags.push(item.replace(HASH_PREFIX_RE, ""));
		} else if (
			typeof item === "object" &&
			item !== null &&
			"name" in item &&
			typeof (item as Record<string, unknown>).name === "string"
		) {
			tags.push(((item as Record<string, unknown>).name as string).replace(HASH_PREFIX_RE, ""));
		}
	}
	return tags;
}

/**
 * Extract Portable Text blocks from EmDash content.
 * Tries common field names for the PT body.
 */
function extractPortableTextBlocks(content: Record<string, unknown>): unknown[] {
	for (const key of ["body", "content", "text"]) {
		const value = content[key];
		if (Array.isArray(value)) {
			return value;
		}
	}
	return [];
}

/**
 * Extract custom fields that don't map to standard.site fields.
 * These ride in the _emdash.fields bag on PDS.
 */
function extractCustomFields(content: Record<string, unknown>): Record<string, unknown> {
	const custom: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(content)) {
		if (!STANDARD_FIELD_NAMES.has(key) && !key.startsWith("_")) {
			custom[key] = value;
		}
	}
	return custom;
}
