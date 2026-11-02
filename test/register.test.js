const {test}=require('node:test');
const assert=require('node:assert/strict');
const R=require('../register-engine');
const items=[{code:'a',name:'商品A',price:101,rate:10,qty:10},{code:'b',name:'食品B',price:101,rate:8,qty:10}];
const request={key:'key1',id:'SR-1',date:'2026-11-02',customer:'テスト株式会社',lines:[{code:'a',qty:1},{code:'a',qty:1},{code:'b',qty:3}],tender:1000};
test('同税率の複数明細は税率別に1回切捨て、混在税率を区分',()=>{
 const t=R.calculate([{qty:1,price:106,rate:10},{qty:1,price:106,rate:10},{qty:2,price:108,rate:8}]);
 assert.deepEqual(t,{subtotal:428,tax:38,total:466,taxes:[{rate:8,net:216,tax:17},{rate:10,net:212,tax:21}]});
});
test('会計は在庫と現金・売上・仮受税に連動し、元データを変更しない',()=>{
 const before=R.initial(items),r=R.sell(before,request);assert.equal(before.items[0].qty,10);assert.equal(r.state.items[0].qty,8);assert.equal(r.state.items[1].qty,7);assert.equal(r.sale.total,549);assert.equal(r.sale.change,451);
 const j=R.journals(r.state.sales);assert.equal(j.filter(x=>x.debit==='1001').reduce((n,x)=>n+x.amount,0),549);assert.equal(j.find(x=>x.credit==='4001').amount,505);assert.equal(j.find(x=>x.credit==='2100').amount,44);
});
test('同一操作の再送で在庫・伝票・入金が重複しない',()=>{const r=R.sell(R.initial(items),request);const s=R.sell(r.state,request);assert.equal(s.duplicate,true);assert.deepEqual(s.state,r.state);});
test('在庫超過・不足金・数量不正・不正税率で取引全体を拒否',()=>{
 const state=R.initial(items),saved=JSON.stringify(state);
 for(const overrides of [{lines:[{code:'a',qty:11}]},{tender:1},{lines:[{code:'a',qty:0}]},{lines:[{code:'a',qty:1.5}]},{customer:''}])assert.throws(()=>R.sell(state,{...request,...overrides}));
 assert.equal(JSON.stringify(state),saved);assert.throws(()=>R.calculate([{qty:1,price:100,rate:5}]));
});
test('取消は在庫を復元し正数の逆仕訳で現金・売上・税を相殺、再取消は無変更',()=>{
 const sale=R.sell(R.initial(items),request),r=R.refund(sale.state,'SR-1','2026-11-03');assert.equal(r.state.items[0].qty,10);assert.equal(r.state.items[1].qty,10);
 const j=R.journals(r.state.sales);for(const code of ['1001','4001','2100'])assert.equal(j.reduce((n,x)=>n+(x.debit===code?x.amount:0)-(x.credit===code?x.amount:0),0),0);assert.ok(j.every(x=>x.amount>0));assert.deepEqual(R.refund(r.state,'SR-1','2026-11-04').state,r.state);
});
test('発行時の名称・登録番号を保持し、後の設定変更が既発行帳票へ波及しない',()=>{const s=R.initial(items);s.issuer={name:'店舗A',regno:'',address:'東京都'};const r=R.sell(s,request);r.state.issuer.name='店舗B';assert.equal(r.state.sales[0].issuer.name,'店舗A');});
test('再読み込み後も伝票・在庫・取消が維持される',()=>{const s=R.sell(R.initial(items),request).state;const loaded=JSON.parse(JSON.stringify(s));const r=R.refund(loaded,'SR-1','2026-11-03');assert.equal(r.state.sales.length,1);assert.equal(r.state.items[0].qty,10);});
