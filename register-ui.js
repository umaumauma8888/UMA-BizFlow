/* Smart register preview: isolated browser storage; no external payment calls. */
(function(){
  'use strict';
  const KEY='uma-bizflow-smart-register-preview-v1', C=BizRegister;
  const money=n=>'¥'+n.toLocaleString('ja-JP');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
  let cart=[],key=crypto.randomUUID(),busy=false,receipt=null,state;
  const baseItems=STOCK_MASTER.map(i=>({...i,rate:10}));
  baseItems.push({code:'FOOD-001',name:'飲料水（持ち帰り）',unit:'本',qty:100,price:120,rate:8,location:'店頭',safety:10,reorder:20,max:200});
  function read(){const raw=localStorage.getItem(KEY);if(!raw)return C.initial(baseItems);const s=JSON.parse(raw);if(s.version!==1||!Array.isArray(s.items)||!Array.isArray(s.sales))throw Error('保存データを読み込めません');return s;}
  try{state=read();}catch(e){state=C.initial(baseItems);busy=true;console.error(e);}
  // Keep every register transaction visible in the existing financial screens.
  function sync(){
    STOCK_MASTER.splice(0,STOCK_MASTER.length,...state.items.map(i=>({...i})));
    for(const loc of STOCK_LOCATIONS){const i=state.items.find(x=>x.code===loc.item);if(i)loc.used=i.qty;}
    for(let i=MASTER_TRANSACTIONS.length-1;i>=0;i--)if(MASTER_TRANSACTIONS[i].smartRegister)MASTER_TRANSACTIONS.splice(i,1);
    for(const s of state.sales){
      const tx={smartRegister:true,orderId:s.id,invoiceNo:s.id,customer_id:null,customer:s.customer,desc:'スマートレジ売上',orderDate:s.date,invoiceDate:s.date,paymentDate:s.date,subtotal:s.subtotal,taxRate:s.taxes.length===1?s.taxes[0].rate/100:0,taxAmount:s.tax,total:s.total,taxLabel:s.taxes.map(g=>g.rate+'%対象').join('・'),paid:true,payMethod:'現金',lines:s.lines.map(l=>({name:l.name,qty:l.qty,price:l.price,unit_price:l.price,tax_rate:l.rate/100}))};
      MASTER_TRANSACTIONS.push(tx);
      if(s.status==='取消')MASTER_TRANSACTIONS.push({...tx,orderId:s.id+'-REFUND',invoiceNo:s.id+'-REFUND',desc:'スマートレジ取消・返金',invoiceDate:s.refundDate,paymentDate:s.refundDate,subtotal:-s.subtotal,taxAmount:-s.tax,total:-s.total,lines:tx.lines.map(l=>({...l,qty:-l.qty}))});
    }
    MOCK_DB._transactions.splice(0,MOCK_DB._transactions.length,...MASTER_TRANSACTIONS);
    window.smartRegisterJournals=C.journals(state.sales);
    if(typeof accJournals!=='undefined'){accJournals=MOCK_DB.journals;accAccounts=MOCK_DB.accounts;}
  }
  sync();
  ALL_TABS.push('register');
  const nav=document.createElement('div');nav.className='sidebar-item';nav.setAttribute('onclick',"setTab(this,'register')");nav.innerHTML='<span class="si-icon">▣</span> スマートレジ';
  const anchor=document.querySelector('.sidebar-item[onclick*="payment"]');anchor.after(nav);
  const panel=document.createElement('div');panel.id='tab-register';panel.style.display='none';
  document.getElementById('tab-home').parentNode.appendChild(panel);
  const oldSetTab=setTab;setTab=function(el,id){oldSetTab(el,id);if(id==='register'){document.getElementById('admin-title').textContent='スマートレジ';document.getElementById('atb-page').textContent='スマートレジ';render();}};
  function totals(){try{return C.calculate(cart.map(l=>{const i=state.items.find(x=>x.code===l.code);return {...i,qty:l.qty};}));}catch(_){return {subtotal:0,tax:0,total:0,taxes:[]};}}
  function notice(msg,error=false){const el=document.getElementById('sr-message');if(el){el.className='sr-notice '+(error?'sr-error':'sr-success');el.textContent=msg;el.hidden=false;}}
  function render(){
    const t=totals(),active=state.sales.filter(s=>s.status==='確定'),today=active.filter(s=>s.date===date());
    const customer=document.getElementById('sr-customer')?.value||'',tender=document.getElementById('sr-tender')?.value||'';
    panel.innerHTML=`<div class="sr-head"><div><h2>スマートレジ</h2><div class="sr-sub">商品選択から会計・在庫・入金・仕訳まで</div></div><div class="sr-sub">本日の売上 <b style="font-size:22px;color:#1a56db">${money(today.reduce((n,s)=>n+s.total,0))}</b> ／ ${today.length}件</div></div>
      <div class="sr-notice">操作デモ：現金会計を体験できます。このコピー専用のデータを使用します。</div><div id="sr-message" role="status" hidden></div>
      <div class="sr-layout"><div class="sr-panel"><h3 style="margin:0">商品を選ぶ <small class="sr-sub">税抜価格</small></h3><label for="sr-search">商品名・商品コードで検索</label><input id="sr-search" type="search" placeholder="商品を検索" style="width:100%"><div class="sr-products" id="sr-products"></div>
      <details class="sr-settings"><summary>店舗・帳票設定</summary><label>発行事業者名<input id="sr-issuer" value="${esc(state.issuer.name)}" maxlength="100"></label><label>登録番号（T＋13桁）<input id="sr-regno" value="${esc(state.issuer.regno)}" placeholder="実際の登録番号を入力" maxlength="14"></label><label>所在地<input id="sr-address" value="${esc(state.issuer.address)}" maxlength="200"></label><button id="sr-save-settings">設定を保存</button><p class="sr-sub">登録番号が未設定の帳票は、適格請求書として発行されません。</p></details></div>
      <div class="sr-panel"><h3 style="margin:0">お会計 <small class="sr-sub">${cart.reduce((n,l)=>n+l.qty,0)}点</small></h3><div id="sr-cart">${cart.length?cart.map(l=>{const i=state.items.find(x=>x.code===l.code);return `<div class="sr-cartrow"><div><b>${esc(i.name)}</b><div class="sr-sub">${money(i.price)} ／ 税率${i.rate}% ${i.rate===8?'（軽減税率）':''}</div><label>数量 <input data-qty="${esc(l.code)}" type="number" min="1" max="${i.qty}" value="${l.qty}"></label></div><div style="text-align:right"><b>${money(i.price*l.qty)}</b><br><button data-remove="${esc(l.code)}" aria-label="${esc(i.name)}を削除">削除</button></div></div>`;}).join(''):'<p class="sr-sub" style="padding:26px 0">左の商品を選択してください。</p>'}</div>
      <div class="sr-totals"><div><span>小計（税抜）</span><b>${money(t.subtotal)}</b></div>${t.taxes.map(g=>`<div class="sr-sub"><span>${g.rate}%対象 ${money(g.net)} ／ 消費税</span><span>${money(g.tax)}</span></div>`).join('')}<div class="sr-total"><span>合計</span><span>${money(t.total)}</span></div></div>
      <label for="sr-customer">宛名（領収書）</label><input id="sr-customer" value="${esc(customer)}" maxlength="100" placeholder="例：株式会社サンプル商事" style="width:100%"><label for="sr-tender">現金お預り金</label><input id="sr-tender" type="number" min="0" step="1" value="${esc(tender)}" inputmode="numeric" style="width:100%"><p id="sr-change" class="sr-sub"></p><div class="sr-actions"><button id="sr-exact">ちょうど</button><button id="sr-clear">商品をクリア</button><button id="sr-checkout" class="sr-primary" ${busy||!cart.length?'disabled':''}>現金会計を確定</button></div></div></div>
      <div id="sr-receipt-area">${receipt?receiptHTML(receipt):''}</div>${receipt?'<div class="sr-actions" style="justify-content:center"><button id="sr-print-button">領収書を印刷・PDF保存</button></div>':''}
      <div class="sr-panel sr-history"><h3>会計履歴</h3><table><thead><tr><th>伝票番号／日付</th><th>宛名</th><th>税込金額</th><th>状態</th><th>操作</th></tr></thead><tbody>${state.sales.length?state.sales.slice(0,100).map(s=>`<tr><td>${esc(s.id)}<br><span class="sr-sub">${esc(s.created)}</span></td><td>${esc(s.customer)}</td><td>${money(s.total)}</td><td>${s.status==='取消'?'取消・返金済':'会計済'}</td><td><button data-receipt="${esc(s.id)}">領収書</button> ${s.status==='確定'?`<button data-refund="${esc(s.id)}" class="sr-danger">取消・返金</button>`:''}</td></tr>`).join(''):'<tr><td colspan="5">会計履歴はありません。</td></tr>'}</tbody></table><div class="sr-actions"><button id="sr-csv">会計履歴CSV</button><button id="sr-ledger">仕訳帳で確認</button><button id="sr-stock">在庫で確認</button><button id="sr-home">ダッシュボードで確認</button></div></div>`;
    productList('');
    document.getElementById('sr-search').oninput=e=>productList(e.target.value);
    panel.querySelectorAll('[data-qty]').forEach(el=>el.onchange=()=>{const qty=Number(el.value),i=state.items.find(i=>i.code===el.dataset.qty);if(!Number.isInteger(qty)||qty<1||qty>i.qty){notice('数量は在庫の範囲内の整数で入力してください',true);return;}cart.find(l=>l.code===i.code).qty=qty;render();});
    panel.querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{cart=cart.filter(l=>l.code!==el.dataset.remove);key=crypto.randomUUID();render();});
    document.getElementById('sr-exact').onclick=()=>{document.getElementById('sr-tender').value=t.total;change();};
    document.getElementById('sr-tender').oninput=change;
    document.getElementById('sr-clear').onclick=()=>{cart=[];key=crypto.randomUUID();render();};
    document.getElementById('sr-checkout').onclick=checkout;
    document.getElementById('sr-save-settings').onclick=saveSettings;
    panel.querySelectorAll('[data-receipt]').forEach(el=>el.onclick=()=>{receipt=state.sales.find(s=>s.id===el.dataset.receipt);render();document.getElementById('sr-receipt-area').scrollIntoView({behavior:'smooth'});});
    panel.querySelectorAll('[data-refund]').forEach(el=>el.onclick=()=>doRefund(el.dataset.refund));
    document.getElementById('sr-print-button')?.addEventListener('click',printReceipt);
    document.getElementById('sr-csv').onclick=csv;
    document.getElementById('sr-ledger').onclick=()=>{goTab('accounting');accLoadFromAPI();};document.getElementById('sr-stock').onclick=()=>goTab('stock');document.getElementById('sr-home').onclick=()=>goTab('home');change();
  }
  function productList(q){document.getElementById('sr-products').innerHTML=state.items.filter(i=>(i.name+i.code).toLowerCase().includes(q.toLowerCase())).map(i=>`<button class="sr-product" data-product="${esc(i.code)}" ${i.qty<1?'disabled':''}><span class="sr-sub">${esc(i.code)} ／ ${i.rate}%</span><strong>${esc(i.name)}</strong><b>${money(i.price)}</b><span class="sr-sub">在庫 ${i.qty}${esc(i.unit||'個')}</span></button>`).join('')||'<p>該当する商品はありません。</p>';panel.querySelectorAll('[data-product]').forEach(el=>el.onclick=()=>{const i=state.items.find(i=>i.code===el.dataset.product),l=cart.find(l=>l.code===i.code);if((l?.qty||0)>=i.qty)return notice('在庫数を超えています',true);if(l)l.qty++;else cart.push({code:i.code,qty:1});key=crypto.randomUUID();render();});}
  function change(){const tender=Number(document.getElementById('sr-tender').value),total=totals().total;document.getElementById('sr-change').textContent=tender>=total?'お釣り '+money(tender-total):'不足 '+money(total-tender);}
  async function mutate(fn){
    const action=()=>{const current=read(),result=fn(current);localStorage.setItem(KEY,JSON.stringify(result.state));state=result.state;sync();return result;};
    if(!navigator.locks)throw Error('このブラウザーでは安全な会計保存に対応していません。最新版のChrome・Edge・Safariを利用してください');
    return navigator.locks.request(KEY,action);
  }
  async function checkout(){if(busy)return;busy=true;document.getElementById('sr-checkout').disabled=true;
    const request={key,id:'SR-'+date().replace(/-/g,'')+'-'+crypto.randomUUID().slice(0,8).toUpperCase(),date:date(),created:new Date().toLocaleString('ja-JP'),customer:document.getElementById('sr-customer').value,lines:cart.map(l=>({...l})),tender:Number(document.getElementById('sr-tender').value)};
    try{const r=await mutate(s=>C.sell(s,request));receipt=r.sale;cart=[];key=crypto.randomUUID();busy=false;render();notice('会計が完了しました。在庫・入金・仕訳に反映しました。');}catch(e){busy=false;document.getElementById('sr-checkout').disabled=false;notice(e.message,true);}
  }
  async function doRefund(id){if(busy||!confirm('現金の返金を行い、この取引を取り消しますか？ 在庫を戻し、取消仕訳を作成します。'))return;busy=true;try{await mutate(s=>C.refund(s,id,date()));receipt=state.sales.find(s=>s.id===id);busy=false;render();notice('取消を記録しました。現金の返金額を領収書で確認してください。');}catch(e){busy=false;notice(e.message,true);}}
  async function saveSettings(){const issuer={name:document.getElementById('sr-issuer').value.trim(),regno:document.getElementById('sr-regno').value.trim(),address:document.getElementById('sr-address').value.trim()};if(!issuer.name)return notice('発行事業者名を入力してください',true);if(issuer.regno&&!/^T\d{13}$/.test(issuer.regno))return notice('登録番号はTと13桁の数字で入力してください',true);try{await mutate(s=>({state:{...s,issuer,revision:s.revision+1}}));notice('店舗設定を保存しました。発行済み帳票の情報は変わりません。');}catch(e){notice(e.message,true);}}
  function receiptHTML(s){return `<article class="sr-receipt"><h3>${s.status==='取消'?'取消・返金記録':'領収書'}</h3><p style="text-align:center;font-weight:700">${esc(s.issuer.name)}</p>${s.issuer.address?`<p style="text-align:center">${esc(s.issuer.address)}</p>`:''}<p>${esc(s.customer)} 御中</p><p>取引日 ${esc(s.date)}<br>伝票番号 ${esc(s.id)}</p><hr>${s.lines.map(l=>`<div class="sr-receipt-line"><span>${esc(l.name)}${l.rate===8?' ※':''}<br><small>${money(l.price)} × ${l.qty}</small></span><b>${money(l.price*l.qty)}</b></div>`).join('')}<hr>${s.taxes.map(g=>`<div class="sr-receipt-line"><span>${g.rate}%対象（税抜）</span><span>${money(g.net)}</span></div><div class="sr-receipt-line"><span>消費税 ${g.rate}%</span><span>${money(g.tax)}</span></div>`).join('')}<div class="sr-receipt-line" style="font-size:20px"><b>合計（税込）</b><b>${money(s.total)}</b></div><hr><div class="sr-receipt-line"><span>現金お預り</span><span>${money(s.tender)}</span></div><div class="sr-receipt-line"><span>お釣り</span><span>${money(s.change)}</span></div>${s.status==='取消'?`<p><b>返金額 ${money(s.total)} ／ 取消日 ${esc(s.refundDate)}</b></p>`:''}<p>※は軽減税率対象。税額は税率ごとに切捨て。</p><p>${s.issuer.regno?'登録番号 '+esc(s.issuer.regno):'登録番号未設定：適格請求書ではありません。'}</p><p style="text-align:center">操作デモの帳票サンプル</p></article>`;}
  function printReceipt(){let el=document.getElementById('sr-print');if(!el){el=document.createElement('div');el.id='sr-print';el.style.display='none';document.body.appendChild(el);}el.innerHTML=receiptHTML(receipt);window.print();}
  function csv(){const rows=[['伝票番号','取引日','宛名','税抜金額','消費税','税込金額','状態','返金日'],...state.sales.map(s=>[s.id,s.date,s.customer,s.subtotal,s.tax,s.total,s.status,s.refundDate||''])];const safe=v=>'"'+String(v).replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')+'"';const b=new Blob(['\uFEFF'+rows.map(r=>r.map(safe).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(b),a=document.createElement('a');a.href=url;a.download='BizFlow_レジ会計履歴.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  window.addEventListener('storage',e=>{if(e.key===KEY){try{state=read();sync();if(panel.style.display!=='none')render();}catch(err){notice(err.message,true);}}});
  if(location.hash==='#smart-register'){doLogin();setTab(nav,'register');}
})();
