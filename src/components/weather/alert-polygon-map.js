// src/components/weather/alert-polygon-map.js
// Renders an NWS alert polygon on an OpenStreetMap tile layer using Leaflet
// loaded from CDN — no npm install required.
import React, { useEffect, useRef } from 'react';

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_INTEGRITY_CSS = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const LEAFLET_INTEGRITY_JS  = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV/hvN/t+c=';

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) {
      resolve(window.L);
      return;
    }

    // CSS
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      link.integrity = LEAFLET_INTEGRITY_CSS;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }

    // JS
    if (!document.getElementById('leaflet-js')) {
      const script = document.createElement('script');
      script.id = 'leaflet-js';
      script.src = LEAFLET_JS;
      script.integrity = LEAFLET_INTEGRITY_JS;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve(window.L);
      script.onerror = () => reject(new Error('Failed to load Leaflet'));
      document.head.appendChild(script);
    } else {
      // Script tag exists but L may not be set yet — wait for it
      const check = setInterval(() => {
        if (window.L) {
          clearInterval(check);
          resolve(window.L);
        }
      }, 50);
    }
  });
}

export default function AlertPolygonMap({ geojson }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!geojson || !containerRef.current) return;

    let geoParsed;
    try {
      geoParsed = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
    } catch {
      return;
    }

    let destroyed = false;

    loadLeaflet()
      .then((L) => {
        if (destroyed || !containerRef.current) return;

        const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: false });
        mapRef.current = map;

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 18,
        }).addTo(map);

        const layer = L.geoJSON(geoParsed, {
          style: {
            color: '#d32f2f',
            weight: 2,
            opacity: 0.9,
            fillColor: '#f44336',
            fillOpacity: 0.2,
          },
        }).addTo(map);

        // Fit the map to the polygon bounds
        const bounds = layer.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [20, 20] });
        }
      })
      .catch((err) => console.warn('[AlertPolygonMap] Leaflet load failed:', err));

    return () => {
      destroyed = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [geojson]);

  if (!geojson) return null;

  return (
    <div style={{ marginTop: 16, marginBottom: 16 }}>
      <p style={{ fontWeight: 600, marginBottom: 8, fontSize: '0.95rem' }}>
        Alert Area Map
      </p>
      <div
        ref={containerRef}
        style={{ height: 320, width: '100%', borderRadius: 4, border: '1px solid #ccc' }}
      />
    </div>
  );
}
