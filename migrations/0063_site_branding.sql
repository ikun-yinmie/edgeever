-- Owner-configurable site branding: browser tab name, description and icon.
-- NULL means "keep the built-in EdgeEver branding". site_icon stores a small
-- image data URL (PNG/JPEG/WebP/GIF/SVG/ICO); site_icon_updated_at doubles as
-- the cache-buster for the public /api/v1/public/site/icon endpoint.
ALTER TABLE instance_settings ADD COLUMN site_name TEXT;
ALTER TABLE instance_settings ADD COLUMN site_description TEXT;
ALTER TABLE instance_settings ADD COLUMN site_icon TEXT;
ALTER TABLE instance_settings ADD COLUMN site_icon_updated_at TEXT;
