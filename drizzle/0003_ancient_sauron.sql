ALTER TABLE "submissions" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "attachment_url" text;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "attachment_cld_pub_id" text;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "attachment_file_name" varchar(255);--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "attachment_file_type" varchar(50);--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "attachment_file_size" integer;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "attachment_url" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "attachment_cld_pub_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "attachment_file_name" varchar(255);--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "attachment_file_type" varchar(50);--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "attachment_file_size" integer;