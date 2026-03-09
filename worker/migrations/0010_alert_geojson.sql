-- migration 0010: add alert_geojson column to store NWS alert polygon geometry
ALTER TABLE articles ADD COLUMN alert_geojson TEXT;
