import { useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';

export interface Pt { lat: number; lng: number }

/**
 * Карта с курьером, точкой забора и доставки (Leaflet + OpenStreetMap внутри WebView).
 * Точки обновляются без перезагрузки карты. Для продакшена тайлы OSM лучше заменить на Яндекс Карты или свой сервер тайлов.
 */
export function LiveMap({ courier, pickup, delivery, height = 260 }: { courier?: Pt | null; pickup?: Pt | null; delivery?: Pt | null; height?: number }) {
  const ref = useRef<WebView>(null);
  const html = useMemo(() => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#m{margin:0;height:100%}.d{width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 3px #0008}</style></head>
<body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false,attributionControl:false}).setView([55.03,82.92],12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
function ic(c){return L.divIcon({className:'',html:'<div class="d" style="background:'+c+'"></div>',iconSize:[22,22],iconAnchor:[11,11]});}
var mk={};var first=true;
function update(p){['courier','pickup','delivery'].forEach(function(k){var v=p[k];var col={courier:'#e5482d',pickup:'#888',delivery:'#0e7c66'}[k];
 if(v){if(mk[k])mk[k].setLatLng([v.lat,v.lng]);else mk[k]=L.marker([v.lat,v.lng],{icon:ic(col)}).addTo(map);}else if(mk[k]){map.removeLayer(mk[k]);delete mk[k];}});
 var pts=Object.keys(mk).map(function(k){return mk[k].getLatLng();});
 if(first&&pts.length){first=false;if(pts.length>1)map.fitBounds(L.latLngBounds(pts),{padding:[30,30]});else map.setView(pts[0],15);}}
</script></body></html>`, []);
  const data = JSON.stringify({ courier: courier ?? null, pickup: pickup ?? null, delivery: delivery ?? null });
  useEffect(() => { ref.current?.injectJavaScript(`update(${data});true;`); }, [data]);
  return <View style={{ height, borderRadius: 14, overflow: 'hidden' }}>
    <WebView ref={ref} originWhitelist={['*']} source={{ html }} onLoadEnd={() => ref.current?.injectJavaScript(`update(${data});true;`)} />
  </View>;
}
