/**
 * dopaminé — Server v3
 * MySQL version for Hostinger
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const mysql      = require('mysql2/promise');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://maisondopamine.com')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-api-key'],
}));
app.use(express.json({ limit: '10mb' }));

// ── STATIC FILES (serves public/ folder)
const path = require('path');
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.get('/admin.html', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));

// ── MYSQL
let db;
async function connectDB() {
  // Hostinger MySQL uses Unix socket — do not use host/port
  const poolConfig = {
    user:               process.env.DB_USER,
    password:           process.env.DB_PASS,
    database:           process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit:    10,
    charset:            'utf8mb4',
  };

  // Use socket if provided (Hostinger), else fall back to host/port (local dev)
  if (process.env.DB_SOCKET) {
    poolConfig.socketPath = process.env.DB_SOCKET;
  } else {
    poolConfig.host = process.env.DB_HOST || '127.0.0.1';
    poolConfig.port = parseInt(process.env.DB_PORT || '3306');
  }

  db = await mysql.createPool(poolConfig);
  await db.query('SELECT 1');
  console.log(`✦ MySQL connected to ${process.env.DB_NAME}`);

  await db.query(`CREATE TABLE IF NOT EXISTS products (id VARCHAR(255) PRIMARY KEY, data JSON NOT NULL, status VARCHAR(50) DEFAULT 'live', createdAt VARCHAR(50), updatedAt VARCHAR(50)) CHARACTER SET utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS orders (id VARCHAR(255) PRIMARY KEY, data JSON NOT NULL, status VARCHAR(50) DEFAULT 'pending', createdAt VARCHAR(50), updatedAt VARCHAR(50)) CHARACTER SET utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS reviews (id VARCHAR(255) PRIMARY KEY, productId VARCHAR(255), data JSON NOT NULL, createdAt VARCHAR(50)) CHARACTER SET utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS messages (id VARCHAR(255) PRIMARY KEY, data JSON NOT NULL, read_status TINYINT DEFAULT 0, createdAt VARCHAR(50)) CHARACTER SET utf8mb4`);
  await db.query("CREATE TABLE IF NOT EXISTS settings (\`key\` VARCHAR(255) PRIMARY KEY, value JSON NOT NULL) CHARACTER SET utf8mb4");
  console.log('✦ Tables ready');
}

function row(r)  { if(!r) return null; try { return typeof r.data==='string'?JSON.parse(r.data):r.data; } catch(e){ return r.data; } }
function rows(a) { return a.map(row).filter(Boolean); }

// ── SHIPROCKET
const SR_EMAIL    = process.env.SR_EMAIL;
const SR_PASSWORD = process.env.SR_PASSWORD;
const SR_BASE     = 'https://apiv2.shiprocket.in/v1/external';
const PICKUP_NAME = process.env.PICKUP_NAME || 'Primary';
let _srToken = null, _srTokenExp = 0;

async function getSRToken() {
  if (_srToken && Date.now() < _srTokenExp) return _srToken;
  const res  = await fetch(`${SR_BASE}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:SR_EMAIL,password:SR_PASSWORD}) });
  const data = await res.json();
  if (!data.token) throw new Error('SR auth failed: '+JSON.stringify(data));
  _srToken=data.token; _srTokenExp=Date.now()+9*24*60*60*1000;
  return _srToken;
}
async function srFetch(path, options={}) {
  const token = await getSRToken();
  const res = await fetch(`${SR_BASE}${path}`, { ...options, headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,...(options.headers||{})} });
  const text = await res.text();
  try { return {status:res.status, data:JSON.parse(text)}; } catch { return {status:res.status, data:{raw:text}}; }
}

const SR_STATUS_MAP = {1:'processing',2:'processing',3:'pickup_scheduled',4:'pickup_scheduled',5:'pickup_scheduled',6:'in_transit',7:'delivered',8:'cancelled',9:'rto',10:'rto',11:'pending',12:'lost',13:'pickup_scheduled',14:'rto',15:'pickup_scheduled',16:'cancelled',17:'out_for_delivery',18:'in_transit',19:'pickup_scheduled'};
const FINAL_STATUSES = ['delivered','cancelled','rto','lost'];

function buildSRPayload(o) {
  const c=o.customer||{}; const phone=(c.phone||'').replace(/\D/g,'').slice(-10); const pincode=(c.postcode||'000000').replace(/\D/g,'')||'000000';
  return { order_id:o.id, order_date:(o.createdAt||new Date().toISOString()).split('T')[0], pickup_location:PICKUP_NAME, channel_id:'', comment:o.deliveryNotes||'', billing_customer_name:`${c.firstName||''} ${c.lastName||''}`.trim(), billing_last_name:c.lastName||'', billing_address:c.addressLine||c.address||'', billing_address_2:'', billing_city:c.city||'', billing_pincode:pincode, billing_state:c.state||'', billing_country:c.country==='IN'?'India':(c.country||'India'), billing_email:c.email||'', billing_phone:phone, shipping_is_billing:true, order_items:(o.items||[]).map(i=>({name:`${i.name}${i.subtitle?' '+i.subtitle:''}`,sku:i.id||'DOPA-001',units:i.qty||1,selling_price:i.price||0,discount:0,tax:0,hsn:'3303'})), payment_method:'Prepaid', shipping_charges:0, giftwrap_charges:0, transaction_charges:0, total_discount:0, sub_total:o.subtotal||o.total||0, length:10, breadth:10, height:10, weight:0.5 };
}

async function updateOrder(id, fields) {
  const [r] = await db.query('SELECT data FROM orders WHERE id=?',[id]);
  if(!r.length) return;
  const cur = typeof r[0].data==='string'?JSON.parse(r[0].data):r[0].data;
  for(const [key,val] of Object.entries(fields)){
    if(key.includes('.')){const p=key.split('.');if(!cur[p[0]])cur[p[0]]={};cur[p[0]][p[1]]=val;}
    else cur[key]=val;
  }
  cur.updatedAt=new Date().toISOString();
  await db.query('UPDATE orders SET data=?,status=?,updatedAt=? WHERE id=?',[JSON.stringify(cur),cur.status||'pending',cur.updatedAt,id]);
}

async function runSRPipeline(order) {
  const oid=order.id;
  try {
    const {status:s1,data:d1}=await srFetch('/orders/create/adhoc',{method:'POST',body:JSON.stringify(buildSRPayload(order))});
    if(s1>=400||!d1.order_id){console.warn(`✗ SR create failed ${oid}:`,JSON.stringify(d1).slice(0,200));return;}
    const srOrderId=d1.order_id; const shipmentId=d1.shipment_id;
    console.log(`✦ SR order created ${oid}: SR#${srOrderId}`);
    await updateOrder(oid,{status:'processing','shiprocket.status':'created','shiprocket.srOrderId':srOrderId,'shiprocket.shipmentId':shipmentId});

    await new Promise(r=>setTimeout(r,3000));
    let courierId=null;
    try {
      const {status:sc,data:dc}=await srFetch(`/courier/serviceability/?shipment_id=${shipmentId}&cod=0&weight=0.5`);
      if(sc<400&&dc?.data?.available_courier_companies?.length){const list=dc.data.available_courier_companies.sort((a,b)=>(b.rating||0)-(a.rating||0)||(a.rate||0)-(b.rate||0));courierId=list[0].courier_company_id;}
    } catch(e){console.warn('Courier error:',e.message);}

    const awbBody={shipment_id:String(shipmentId)};if(courierId)awbBody.courier_id=String(courierId);
    const {status:s3,data:d3}=await srFetch('/courier/assign/awb',{method:'POST',body:JSON.stringify(awbBody)});
    const awb=d3?.response?.data?.awb_code||d3?.awb_code||null; const courierName=d3?.response?.data?.courier_name||'';
    if(s3>=400||!awb){console.warn(`✗ AWB failed ${oid}`);return;}
    await updateOrder(oid,{status:'pickup_scheduled','shiprocket.status':'awb_assigned','shiprocket.awb':awb,'shiprocket.courier':courierName,'shiprocket.trackingUrl':`https://shiprocket.co/tracking/${awb}`});

    await new Promise(r=>setTimeout(r,2000));
    const {status:s4,data:d4}=await srFetch('/courier/generate/pickup',{method:'POST',body:JSON.stringify({shipment_id:[shipmentId]})});
    if(s4<400)await updateOrder(oid,{'shiprocket.status':'pickup_requested','shiprocket.pickupDate':d4?.response?.pickup_scheduled_date||''});

    await new Promise(r=>setTimeout(r,2000));
    const {status:s5,data:d5}=await srFetch('/manifests/generate',{method:'POST',body:JSON.stringify({shipment_id:[shipmentId]})});
    if(s5<400)await updateOrder(oid,{'shiprocket.status':'manifested','shiprocket.manifestUrl':d5?.manifest_url||''});
  } catch(e){console.error(`SR pipeline error ${oid}:`,e.message);}
}

// ── HEALTH
app.get('/health',(_req,res)=>res.json({status:'ok',service:'dopamine server v3',ts:new Date().toISOString()}));

// ── PRODUCTS
app.get('/api/products',async(_req,res)=>{try{const[r]=await db.query("SELECT data FROM products WHERE status='live'");res.json(rows(r));}catch(err){res.status(500).json({error:err.message});}});
app.get('/api/admin/products',async(_req,res)=>{try{const[r]=await db.query('SELECT data FROM products');res.json(rows(r));}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/products',async(req,res)=>{try{const p={...req.body,createdAt:new Date().toISOString()};await db.query('INSERT INTO products (id,data,status,createdAt) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),status=VALUES(status),updatedAt=NOW()',[p.id,JSON.stringify(p),p.status||'live',p.createdAt]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.put('/api/products/:id',async(req,res)=>{try{const{_id,...update}=req.body;update.updatedAt=new Date().toISOString();await db.query('INSERT INTO products (id,data,status,updatedAt) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),status=VALUES(status),updatedAt=VALUES(updatedAt)',[req.params.id,JSON.stringify(update),update.status||'live',update.updatedAt]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.delete('/api/products/:id',async(req,res)=>{try{await db.query('DELETE FROM products WHERE id=?',[req.params.id]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});

// ── ORDERS
app.get('/api/orders',async(_req,res)=>{try{const[r]=await db.query('SELECT data FROM orders ORDER BY createdAt DESC');res.json(rows(r));}catch(err){res.status(500).json({error:err.message});}});
app.get('/api/orders/:id',async(req,res)=>{try{const[r]=await db.query('SELECT data FROM orders WHERE id=?',[req.params.id]);if(!r.length)return res.status(404).json({error:'Order not found'});res.json(row(r[0]));}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/orders',async(req,res)=>{try{const order={...req.body,createdAt:req.body.createdAt||new Date().toISOString()};await db.query('INSERT INTO orders (id,data,status,createdAt) VALUES(?,?,?,?)',[order.id,JSON.stringify(order),order.status||'pending',order.createdAt]);res.json({ok:true,id:order.id});setImmediate(async()=>{try{await sendOrderConfirmation(order);}catch(e){console.error('Email:',e.message);}});setImmediate(async()=>{await runSRPipeline(order);});}catch(err){res.status(500).json({error:err.message});}});
app.put('/api/orders/:id',async(req,res)=>{try{const{_id,...update}=req.body;update.updatedAt=new Date().toISOString();await updateOrder(req.params.id,update);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.delete('/api/orders/:id',async(req,res)=>{try{await db.query('DELETE FROM orders WHERE id=?',[req.params.id]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/orders/:id/cancel-shipment',async(req,res)=>{try{const[r]=await db.query('SELECT data FROM orders WHERE id=?',[req.params.id]);if(!r.length)return res.status(404).json({error:'Order not found'});const o=row(r[0]);const awb=o.shiprocket?.awb;if(!awb)return res.status(400).json({error:'No AWB'});const{status,data}=await srFetch('/orders/cancel/shipment/awbs',{method:'POST',body:JSON.stringify({awbs:[awb]})});if(status>=400)return res.status(status).json({error:data});await updateOrder(req.params.id,{status:'cancelled','shiprocket.status':'shipment_cancelled'});res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});

// ── FEATURED
app.get('/api/featured',async(_req,res)=>{try{const[r]=await db.query("SELECT value FROM settings WHERE \`key\`='featured'");if(!r.length)return res.json(null);res.json(typeof r[0].value==='string'?JSON.parse(r[0].value):r[0].value);}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/featured',async(req,res)=>{try{await db.query("INSERT INTO settings (\`key\`,value) VALUES('featured',?) ON DUPLICATE KEY UPDATE value=VALUES(value)",[JSON.stringify(req.body)]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});

// ── REVIEWS
app.get('/api/reviews',async(_req,res)=>{try{const[r]=await db.query('SELECT data,productId FROM reviews');const grouped={};rows(r).forEach((rev,i)=>{const pid=r[i].productId;if(!grouped[pid])grouped[pid]=[];grouped[pid].push(rev);});res.json(grouped);}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/reviews',async(req,res)=>{try{const rv={...req.body,createdAt:new Date().toISOString()};await db.query('INSERT INTO reviews (id,productId,data,createdAt) VALUES(?,?,?,?)',[rv.id||Date.now().toString(),rv.productId,JSON.stringify(rv),rv.createdAt]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.put('/api/reviews/:id',async(req,res)=>{try{const[r]=await db.query('SELECT data FROM reviews WHERE id=?',[req.params.id]);if(!r.length)return res.status(404).json({error:'Not found'});const updated={...row(r[0]),...req.body};await db.query('UPDATE reviews SET data=? WHERE id=?',[JSON.stringify(updated),req.params.id]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.delete('/api/reviews/:id',async(req,res)=>{try{await db.query('DELETE FROM reviews WHERE id=?',[req.params.id]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});

// ── MESSAGES
app.get('/api/messages',async(_req,res)=>{try{const[r]=await db.query('SELECT data FROM messages ORDER BY createdAt DESC');res.json(rows(r));}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/messages',async(req,res)=>{try{const msg={...req.body,createdAt:new Date().toISOString(),read:false};await db.query('INSERT INTO messages (id,data,read_status,createdAt) VALUES(?,?,0,?)',[msg.id||Date.now().toString(),JSON.stringify(msg),msg.createdAt]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.put('/api/messages/:id',async(req,res)=>{try{const[r]=await db.query('SELECT data FROM messages WHERE id=?',[req.params.id]);if(!r.length)return res.status(404).json({error:'Not found'});const updated={...row(r[0]),...req.body};await db.query('UPDATE messages SET data=?,read_status=? WHERE id=?',[JSON.stringify(updated),updated.read?1:0,req.params.id]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});
app.delete('/api/messages/:id',async(req,res)=>{try{await db.query('DELETE FROM messages WHERE id=?',[req.params.id]);res.json({ok:true});}catch(err){res.status(500).json({error:err.message});}});

// ── SHIPROCKET MANUAL
app.get('/api/shiprocket/couriers/:shipment_id',async(req,res)=>{try{const{status,data}=await srFetch(`/courier/serviceability/?shipment_id=${req.params.shipment_id}&cod=0`);if(status>=400)return res.status(status).json({error:data});const couriers=(data?.data?.available_courier_companies||[]).map(c=>({courier_company_id:c.courier_company_id,courier_name:c.courier_name,rate:c.rate,etd:c.etd,cod:c.cod,rating:c.rating}));res.json({couriers});}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/shiprocket/assign-courier',async(req,res)=>{try{const{shipment_id,courier_id,order_id}=req.body;if(!shipment_id||!courier_id)return res.status(400).json({error:'shipment_id and courier_id required'});const{status,data}=await srFetch('/courier/assign/awb',{method:'POST',body:JSON.stringify({shipment_id,courier_id})});if(status>=400)return res.status(status).json({error:data});const r=data?.response?.data||{};const awb=r.awb_code||data.awb_code;if(order_id&&awb)await updateOrder(order_id,{status:'pickup_scheduled','shiprocket.status':'awb_assigned','shiprocket.awb':awb,'shiprocket.courier':r.courier_name||'','shiprocket.trackingUrl':`https://shiprocket.co/tracking/${awb}`});res.json({awb_code:awb,courier_name:r.courier_name||'',assigned:true});}catch(err){res.status(500).json({error:err.message});}});
app.get('/api/shiprocket/track/:awb',async(req,res)=>{try{const{status,data}=await srFetch(`/courier/track/awb/${req.params.awb}`);if(status>=400)return res.status(status).json({error:data});const td=data?.tracking_data||{};const events=(td.shipment_track_activities||[]).map(e=>({date:e.date,activity:e.activity,location:e.location,status:e['sr-status-label']||''}));res.json({awb:req.params.awb,status:td.shipment_status_label||'',courier:td.courier_agent_details?.name||'',etd:td.etd||'',events});}catch(err){res.status(500).json({error:err.message});}});

// ── WEBHOOK
// Setup: Shiprocket → Settings → API → Webhooks
// URL: https://maisondopamine.com/webhook/tracking
// x-api-key: value of WEBHOOK_SECRET env var
app.post('/webhook/tracking',async(req,res)=>{
  try{
    const secret=process.env.WEBHOOK_SECRET;
    if(secret&&req.headers['x-api-key']!==secret)return res.status(401).json({error:'Unauthorized'});
    res.status(200).json({received:true});
    const body=req.body||{};const awb=body.awb;const srCode=body.current_status_id||body.shipment_status_id;const srLabel=body.current_status||body.shipment_status||'';const srOrderId=body.sr_order_id;
    if(!awb&&!srOrderId)return;
    const newStatus=SR_STATUS_MAP[srCode]||null;if(!newStatus)return;
    let orderRow;
    if(awb){const[r]=await db.query("SELECT id FROM orders WHERE JSON_EXTRACT(data,'$.shiprocket.awb')=?",[awb]);orderRow=r[0];}
    else{const[r]=await db.query("SELECT id FROM orders WHERE JSON_EXTRACT(data,'$.shiprocket.srOrderId')=?",[srOrderId]);orderRow=r[0];}
    if(!orderRow){console.warn(`Webhook: order not found AWB=${awb}`);return;}
    await updateOrder(orderRow.id,{status:newStatus,'shiprocket.srStatusLabel':srLabel,'shiprocket.lastSynced':new Date().toISOString()});
    console.log(`✦ Webhook: ${orderRow.id} → ${newStatus}`);
  }catch(e){console.error('Webhook error:',e.message);}
});

// ── AUTO TRACKING SYNC
async function syncTrackingStatuses(){
  try{
    const placeholders=FINAL_STATUSES.map(()=>'?').join(',');
    const[active]=await db.query(`SELECT id,data FROM orders WHERE status NOT IN (${placeholders}) AND JSON_EXTRACT(data,'$.shiprocket.awb') IS NOT NULL`,FINAL_STATUSES);
    if(!active.length)return;
    console.log(`✦ Syncing ${active.length} active orders`);
    for(const orderRow of active){
      try{
        const o=row(orderRow);
        const{status,data}=await srFetch(`/courier/track/awb/${o.shiprocket.awb}`);
        if(status>=400)continue;
        const td=data?.tracking_data||{};const srCode=td.shipment_status;const srLabel=td.shipment_status_label||'';
        const events=(td.shipment_track_activities||[]).map(e=>({date:e.date,activity:e.activity,location:e.location,status:e['sr-status-label']||''}));
        const newStatus=SR_STATUS_MAP[srCode]||null;
        const fields={'shiprocket.events':events,'shiprocket.srStatusLabel':srLabel,'shiprocket.lastSynced':new Date().toISOString()};
        if(newStatus&&newStatus!==o.status){fields.status=newStatus;console.log(`  ✦ ${o.id}: ${o.status} → ${newStatus}`);}
        await updateOrder(o.id,fields);
        await new Promise(r=>setTimeout(r,500));
      }catch(e){console.warn(`Sync error ${orderRow.id}:`,e.message);}
    }
  }catch(e){console.error('Sync failed:',e.message);}
}

// ── EMAIL
let transporter=null;
try{
  const nodemailer=require('nodemailer');
  if(process.env.EMAIL_USER&&process.env.EMAIL_PASS){
    transporter=nodemailer.createTransport({service:'gmail',auth:{user:process.env.EMAIL_USER,pass:process.env.EMAIL_PASS}});
    console.log('✦ Email ready');
  }else{console.log('⚠ Email not configured');}
}catch(e){console.warn('nodemailer unavailable');}

async function sendOrderConfirmation(order){
  if(!transporter)return;
  const c=order.customer||{};
  const itemsHTML=(order.items||[]).map(i=>`<tr><td style="padding:8px 0;border-bottom:1px solid #2a2418;color:#e8e0d0;font-family:Georgia,serif;font-size:15px;">${i.emoji||'✦'} ${i.name} ${i.subtitle||''}</td><td style="padding:8px 0;border-bottom:1px solid #2a2418;color:#9a8e82;font-size:11px;text-align:center;">${i.size||''} × ${i.qty}</td><td style="padding:8px 0;border-bottom:1px solid #2a2418;color:#A8945E;font-family:Georgia,serif;font-size:15px;text-align:right;">₹${((i.lineTotal||i.price*i.qty)||0).toLocaleString('en-IN')}</td></tr>`).join('');
  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#0a0804;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;"><div style="max-width:560px;margin:0 auto;background:#0a0804;"><div style="padding:48px 40px 32px;text-align:center;border-bottom:1px solid #2a2418;"><div style="font-family:Georgia,serif;font-size:28px;color:#e8e0d0;letter-spacing:6px;font-weight:300;">dopaMin<em style="font-style:italic;color:#A8945E;">é</em></div><div style="font-size:9px;letter-spacing:4px;color:#6a6060;text-transform:uppercase;margin-top:8px;">Maison de Parfum</div></div><div style="padding:40px;"><div style="font-size:9px;letter-spacing:4px;color:#A8945E;text-transform:uppercase;margin-bottom:16px;">✦ Order Confirmed</div><div style="font-family:Georgia,serif;font-size:26px;color:#e8e0d0;margin-bottom:8px;font-weight:300;">Thank you, ${c.firstName||''}</div><div style="font-size:10px;color:#6a6060;margin-bottom:32px;line-height:1.8;">Your order has been received and is being prepared for dispatch.</div><div style="background:#12100c;border:1px solid #2a2418;padding:20px 24px;margin-bottom:32px;text-align:center;"><div style="font-size:8px;letter-spacing:4px;color:#A8945E;text-transform:uppercase;margin-bottom:8px;">Order ID</div><div style="font-family:Georgia,serif;font-size:22px;color:#e8e0d0;letter-spacing:3px;">${order.id}</div></div><div style="margin-bottom:32px;"><table style="width:100%;border-collapse:collapse;">${itemsHTML}<tr><td colspan="2" style="padding:16px 0 0;font-size:9px;color:#6a6060;text-transform:uppercase;">Total</td><td style="padding:16px 0 0;text-align:right;font-family:Georgia,serif;font-size:20px;color:#A8945E;">₹${(order.total||0).toLocaleString('en-IN')}</td></tr></table></div><div style="background:#12100c;border:1px solid #2a2418;padding:20px 24px;margin-bottom:32px;"><div style="font-size:8px;letter-spacing:4px;color:#6a6060;text-transform:uppercase;margin-bottom:12px;">Delivering to</div><div style="font-size:12px;color:#e8e0d0;line-height:1.8;">${c.firstName||''} ${c.lastName||''}<br>${c.addressLine||c.address||''}${c.city?', '+c.city:''}${c.postcode?' '+c.postcode:''}<br>${c.country||''}</div></div><div style="text-align:center;margin:32px 0;"><a href="https://maisondopamine.com/#track" style="display:inline-block;background:transparent;border:1px solid #A8945E;color:#A8945E;font-size:9px;letter-spacing:4px;text-transform:uppercase;padding:14px 32px;text-decoration:none;">Track Your Order →</a></div><div style="font-size:9px;color:#4a4040;text-align:center;line-height:1.8;">Questions? <a href="mailto:hello@maisondopamine.com" style="color:#A8945E;text-decoration:none;">hello@maisondopamine.com</a></div></div><div style="padding:24px 40px;border-top:1px solid #2a2418;text-align:center;"><div style="font-size:8px;letter-spacing:3px;color:#3a3030;text-transform:uppercase;">© 2026 dopaminé · Maison de Parfum</div></div></div></body></html>`;
  try{await transporter.sendMail({from:process.env.EMAIL_FROM||`dopaminé <${process.env.EMAIL_USER}>`,to:c.email,subject:`Order Confirmed — ${order.id} ✦ dopaminé`,html});console.log(`✦ Email sent to ${c.email}`);}
  catch(e){console.error('Email failed:',e.message);}
}

// ── START
// Start server first so Hostinger proxy can reach it
// Then connect to DB — server stays up even if DB has issues
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${PORT}`));

connectDB()
  .then(() => {
    setTimeout(syncTrackingStatuses, 10000);
    setInterval(syncTrackingStatuses, 30 * 60 * 1000);
  })
  .catch(err => {
    console.error('DB connection failed — server still running:', err.message);
    // Retry DB connection every 30 seconds
    setInterval(async () => {
      try {
        await connectDB();
        console.log('✦ DB reconnected successfully');
      } catch(e) {
        console.error('DB retry failed:', e.message);
      }
    }, 30000);
  });