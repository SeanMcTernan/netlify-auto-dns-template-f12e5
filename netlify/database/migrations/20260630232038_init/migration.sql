CREATE TABLE "processed_sites" (
	"site_id" text PRIMARY KEY,
	"name" text NOT NULL,
	"custom_domain" text,
	"action" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_meta" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
