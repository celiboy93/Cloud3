import { S3Client, GetObjectCommand } from "npm:@aws-sdk/client-s3";
import { Upload } from "npm:@aws-sdk/lib-storage";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner"; 
import { timingSafeEqual } from "jsr:@std/crypto/timing-safe-equal";

// --- 1. CONFIGURATION ---
const REQUIRED_ENV_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"];
for (const v of REQUIRED_ENV_VARS) if (!Deno.env.get(v)) throw new Error(`Missing: ${v}`);

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME")!;
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL")!;
const BASIC_AUTH_USER = Deno.env.get("BASIC_AUTH_USER");
const BASIC_AUTH_PASS = Deno.env.get("BASIC_AUTH_PASS");

// --- 2. SETUP ---
const kv = await Deno.openKv();
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});
const MAX_DATE_MS = 9999999999999;

// --- 3. HELPERS ---
function mimeToExt(mime: string): string {
  const m: any = {'video/mp4':'mp4','video/webm':'webm','video/x-matroska':'mkv','video/quicktime':'mov','video/avi':'avi','image/jpeg':'jpg','image/png':'png','image/gif':'gif'};
  return m[mime.split(';')[0]] || 'bin';
}
function formatTimeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime())/1000);
  if(s>31536000)return Math.floor(s/31536000)+"y ago"; if(s>2592000)return Math.floor(s/2592000)+"mo ago";
  if(s>86400)return Math.floor(s/86400)+"d ago"; if(s>3600)return Math.floor(s/3600)+"h ago";
  if(s>60)return Math.floor(s/60)+"m ago"; return s+"s ago";
}
function sanitize(n: string|null): string|null {
  return n ? n.replace(/[^\w\-. ]/g, "").replace(/\s+/g, "-").trim() : "file";
}

// --- 4. SERVER ---
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Auth Check (Skip for downloads)
  if (!url.pathname.startsWith("/download/")) {
      if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
        const auth = req.headers.get("Authorization");
        if (auth) {
          const [u, p] = new TextDecoder().decode(Uint8Array.from(atob(auth.split(" ")[1]), c=>c.charCodeAt(0))).split(":");
          const enc = new TextEncoder();
          if (!(timingSafeEqual(enc.encode(u), enc.encode(BASIC_AUTH_USER)) && timingSafeEqual(enc.encode(p), enc.encode(BASIC_AUTH_PASS)))) {
             return new Response("Unauthorized", {status:401, headers:{'WWW-Authenticate':'Basic realm="Restricted"'}});
          }
        } else {
             return new Response("Unauthorized", {status:401, headers:{'WWW-Authenticate':'Basic realm="Restricted"'}});
        }
      }
  }

  // --- ROUTE 1: UPLOADER UI ---
  if (req.method === "GET" && url.pathname === "/") {
    return new Response(`<!DOCTYPE html><html><head><title>R2 Uploader</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      :root{--bg:#0f172a;--card:#1e293b;--text:#f1f5f9;--accent:#3b82f6;--border:#334155;}
      body{font-family:'Segoe UI', sans-serif;background:var(--bg);color:var(--text);margin:0;display:grid;place-items:center;min-height:100vh;}
      .box{background:var(--card);padding:2.5rem;border-radius:16px;width:90%;max-width:420px;box-shadow:0 20px 40px -10px rgba(0,0,0,0.5);border:1px solid var(--border);}
      .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem;} 
      h2{margin:0;font-weight:600;} a{color:var(--accent);text-decoration:none;}
      .tabs{display:flex;background:#0f172a;padding:4px;border-radius:10px;margin-bottom:1.5rem;}
      .tab{flex:1;padding:0.6rem;background:none;border:none;color:#94a3b8;cursor:pointer;font-size:0.9rem;border-radius:8px;transition:0.3s;font-weight:500;}
      .tab.active{background:var(--accent);color:#fff;} .content{display:none;} .content.active{display:block;}
      .btn{width:100%;padding:1rem;background:var(--accent);color:#fff;border:none;border-radius:10px;cursor:pointer;margin-top:1.5rem;font-weight:600;}
      .btn:disabled{background:#334155;color:#94a3b8;cursor:not-allowed;}
      input{width:100%;padding:1rem;background:#0f172a;border:1px solid var(--border);color:#fff;border-radius:10px;box-sizing:border-box;margin-bottom:0.8rem;outline:none;}
      #fileBox{border:2px dashed var(--border);padding:2.5rem;text-align:center;border-radius:12px;cursor:pointer;}
      #fileBox:hover{background:#0f172a;border-color:var(--accent);}
      .progress-container {margin-top:20px; display:none;}
      .progress-track {height:8px; background:#0f172a; border-radius:4px; overflow:hidden;}
      .progress-fill {height:100%; width:0%; background: linear-gradient(90deg, var(--accent), #a855f7); transition: width 0.3s ease-out;}
      #progPct {text-align:right; font-size:0.8rem; color:#94a3b8; display:block; margin-bottom:5px;}
      .link-group {display:flex; margin-top:10px; flex-direction: column;}
      .link-row {display:flex; margin-bottom:5px;}
      .link-row input {margin-bottom:0; border-radius:8px 0 0 8px; font-family:monospace; color:#60a5fa; flex:1;}
      .copy-btn {background:var(--border); color:white; border:none; padding:0 15px; border-radius:0 8px 8px 0; cursor:pointer;}
      .lbl {font-size:0.7rem; color:#64748b; margin-bottom:2px;}
    </style></head><body>
    <div class="box">
      <div class="head"><h2>R2 Uploader</h2><a href="/history">History</a></div>
      <div class="tabs">
        <button class="tab active" id="tab-btn-file" onclick="openTab('file')">File</button>
        <button class="tab" id="tab-btn-url" onclick="openTab('url')">URL</button>
      </div>
      <div id="view-file" class="content active">
        <form id="fForm">
          <label id="fileBox"><input type="file" id="file" hidden><span>Choose File</span><div id="fName" style="color:var(--accent);margin-top:10px"></div></label>
          <button class="btn" id="fBtn" disabled>Upload</button>
        </form>
      </div>
      <div id="view-url" class="content">
        <form id="uForm"><input id="urlInput" placeholder="Video URL" type="url" required><input id="nameInput" placeholder="Filename"><button class="btn" id="uBtn">Remote Upload</button></form>
      </div>
      <div class="progress-container" id="progBox"><span id="progPct">0%</span><div class="progress-track"><div class="progress-fill" id="bar"></div></div></div>
      <div id="res" style="margin-top:20px"></div>
    </div>
    <script>
      function openTab(n){document.querySelectorAll('.content').forEach(e=>e.classList.remove('active'));document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));document.getElementById('view-'+n).classList.add('active');document.getElementById('tab-btn-'+n).classList.add('active');}
      const fIn=document.getElementById('file'), fName=document.getElementById('fName'), fBtn=document.getElementById('fBtn');
      fIn.onchange=()=>{if(fIn.files.length){fName.innerText=fIn.files[0].name;fBtn.disabled=false;}else{fName.innerText='';fBtn.disabled=true;}};
      function updateProg(p){document.getElementById('progBox').style.display='block';document.getElementById('bar').style.width=p+'%';document.getElementById('progPct').innerText=p+'%';}
      
      const handleUpload = (url, body) => {
          const xhr=new XMLHttpRequest(); xhr.open('POST', url);
          xhr.upload.onprogress=e=>{if(e.lengthComputable) updateProg(Math.round((e.loaded/e.total)*100))};
          xhr.onload=()=>{
             document.getElementById('progBox').style.display='none'; fBtn.disabled=false; document.getElementById('uBtn').disabled=false;
             try{const d=JSON.parse(xhr.responseText); show(d)}catch{alert('Error')}
          };
          xhr.send(body);
      };

      document.getElementById('fForm').onsubmit=e=>{e.preventDefault(); fBtn.disabled=true; const fd=new FormData(); fd.append('file',fIn.files[0]); handleUpload('/upload-file', fd);};
      
      document.getElementById('uForm').onsubmit=e=>{
          e.preventDefault(); document.getElementById('uBtn').disabled=true; updateProg(0);
          fetch('/upload-remote',{method:'POST',body:JSON.stringify({url:document.getElementById('urlInput').value, name:document.getElementById('nameInput').value})})
          .then(r=>{
              const reader=r.body.getReader(); let dec=new TextDecoder(), buf='';
              return reader.read().then(function process({done,value}){
                  if(done) return; buf+=dec.decode(value,{stream:true}); let lines=buf.split('\\n'); buf=lines.pop();
                  lines.forEach(l=>{if(l){const m=JSON.parse(l); if(m.progress)updateProg(m.progress); if(m.done)show(m.done);}});
                  return reader.read().then(process);
              });
          }).catch(e=>alert(e));
      };

      function copyTxt(btn,t){navigator.clipboard.writeText(t).then(()=>{btn.innerText='✓';setTimeout(()=>btn.innerText='Copy',1000)})}
      function show(d){
          document.getElementById('res').innerHTML=\`
          <div class="link-group">
            <div class="lbl">App Link (3hr Redirect)</div>
            <div class="link-row"><input readonly value="\${d.appLink}"><button class="copy-btn" onclick="copyTxt(this,'\${d.appLink}')">Copy</button></div>
          </div>
          <div class="link-group" style="margin-top:10px">
            <div class="lbl">R2 Direct Link (Permanent)</div>
            <div class="link-row"><input readonly value="\${d.r2Url}"><button class="copy-btn" onclick="copyTxt(this,'\${d.r2Url}')">Copy</button></div>
          </div>\`;
      }
    </script></body></html>`, {headers:{"content-type":"text/html"}});
  }

  // --- ROUTE 2: UPLOAD FILE ---
  if (req.method === "POST" && url.pathname === "/upload-file") {
    try {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) return Response.json({error:"No file"},{status:400});
      
      const ext = mimeToExt(file.type);
      const fileName = `${sanitize(file.name)||crypto.randomUUID()}.${ext}`;
      
      const upload = new Upload({
        client: s3Client,
        params: { 
            Bucket: R2_BUCKET_NAME, 
            Key: fileName, 
            Body: file.stream(), 
            ContentType: file.type,
            ContentDisposition: `attachment; filename="${fileName}"`,
            CacheControl: "public, max-age=31536000, immutable"
        },
        // 🔥 UPDATED SETTINGS: 30MB Part Size, 4 Concurrent 🔥
        queueSize: 4, 
        partSize: 30 * 1024 * 1024 
      });
      await upload.done();

      const appLink = `https://${url.host}/download/${fileName}`;
      const r2Url = `https://${R2_PUBLIC_URL}/${fileName}`;
      const data = { id: crypto.randomUUID(), fileName, appLink, r2Url, createdAt: new Date(), source: "File" };
      await kv.set(["uploads", MAX_DATE_MS - Date.now(), data.id], data);
      return Response.json({appLink, r2Url});
    } catch (e) { return Response.json({error:e.message},{status:500}); }
  }

  // --- ROUTE 3: REMOTE UPLOAD ---
  if (req.method === "POST" && url.pathname === "/upload-remote") {
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const push = (d: any) => controller.enqueue(enc.encode(JSON.stringify(d) + "\n"));
        try {
          const {url:u, name:n} = await req.json();
          const r = await fetch(u);
          if(!r.ok) throw new Error("Fetch error");
          const total = parseInt(r.headers.get("content-length")||"0");
          const fileName = `${sanitize(n)||crypto.randomUUID()}.${mimeToExt(r.headers.get("content-type")||"")}`;
          
          const upload = new Upload({
            client: s3Client,
            params: { 
                Bucket: R2_BUCKET_NAME, 
                Key: fileName, 
                Body: r.body as any, 
                ContentType: r.headers.get("content-type")||"application/octet-stream",
                ContentDisposition: `attachment; filename="${fileName}"`,
                CacheControl: "public, max-age=31536000, immutable"
            },
            // 🔥 UPDATED SETTINGS: 30MB Part Size, 4 Concurrent 🔥
            queueSize: 4, 
            partSize: 30 * 1024 * 1024 
          });
          upload.on("httpUploadProgress", p => { if(total) push({progress:Math.round((p.loaded!/total)*100)}) });
          await upload.done();

          const appLink = `https://${url.host}/download/${fileName}`;
          const r2Url = `https://${R2_PUBLIC_URL}/${fileName}`;
          const data = { id: crypto.randomUUID(), fileName, appLink, r2Url, createdAt: new Date(), source: "URL" };
          await kv.set(["uploads", MAX_DATE_MS - Date.now(), data.id], data);
          push({done:{appLink, r2Url}});
        } catch (e) { push({error:e.message}); }
        controller.close();
      }
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
  }

  // --- ROUTE 4: PUBLIC DOWNLOAD (REDIRECT with 3 Hour Expiry) ---
  if (req.method === "GET" && url.pathname.startsWith("/download/")) {
    const key = url.pathname.substring(10); 
    
    try {
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            ResponseContentDisposition: `attachment; filename="${key}"`,
            ResponseCacheControl: "public, max-age=31536000"
        });
        
        // Expires in 3 Hours (10800 seconds)
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 10800 });
        return Response.redirect(signedUrl, 302);
    } catch (e) {
        return new Response("Link expired or file not found", { status: 404 });
    }
  }

  // --- ROUTE 5: HISTORY ---
  if (req.method === "GET" && url.pathname === "/history") {
    const iter = kv.list({ prefix: ["uploads"] }, { limit: 50 });
    let items = "";
    for await (const e of iter) {
      const v = e.value as any;
      const k = JSON.stringify(e.key);
      items += `
      <div class="item">
        <div class="top"><b>${v.fileName}</b><button onclick='del(${k})'>Del</button></div>
        <div class="meta">${formatTimeAgo(new Date(v.createdAt))}</div>
        <div class="link-group">
            <div class="lbl">App Link</div>
            <div class="link-row"><input readonly value="${v.appLink}"><button class="copy-btn" onclick="copyTxt(this,'${v.appLink}')">Copy</button></div>
        </div>
        <div class="link-group" style="margin-top:5px">
            <div class="lbl">R2 Direct</div>
            <div class="link-row"><input readonly value="${v.r2Url}"><button class="copy-btn" onclick="copyTxt(this,'${v.r2Url}')">Copy</button></div>
        </div>
      </div>`;
    }
    return new Response(`<!DOCTYPE html><html><head><title>History</title><meta name="viewport" content="width=device-width"><style>body{background:#0f172a;color:#fff;font-family:sans-serif;padding:1rem;max-width:600px;margin:0 auto}.item{background:#1e293b;padding:1rem;margin-bottom:10px;border-radius:8px}.link-group{display:flex;flex-direction:column}.link-row{display:flex;margin-top:2px}input{background:#0f172a;border:none;color:#60a5fa;flex:1;padding:5px;border-radius:4px 0 0 4px}button{background:#334155;color:#fff;border:none;padding:5px 10px;cursor:pointer}.lbl{font-size:0.7rem;color:#64748b}.copy-btn{border-radius:0 4px 4px 0}</style><script>async function del(k){if(confirm('Delete?'))await fetch('/api/delete-history',{method:'POST',body:JSON.stringify({key:k})});location.reload()} function copyTxt(b,t){navigator.clipboard.writeText(t);b.innerText='✓';setTimeout(()=>b.innerText='Copy',1000)}</script></head><body><h2>History</h2><a href="/" style="color:#60a5fa">Back</a><br><br>${items}</body></html>`,{headers:{"content-type":"text/html"}});
  }

  // --- ROUTE 6: DELETE API ---
  if (req.method === "POST" && url.pathname === "/api/delete-history") {
      const {key} = await req.json(); await kv.delete(key); return Response.json({ok:true});
  }

  return new Response("404", { status: 404 });
});
