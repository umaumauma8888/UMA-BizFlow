(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.BizRegister=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const clone=x=>JSON.parse(JSON.stringify(x));
  function integer(n,label,min=0){if(!Number.isSafeInteger(n)||n<min||n>1000000000)throw Error(label+'が不正です');return n;}
  function calculate(lines){
    if(!Array.isArray(lines)||!lines.length||lines.length>100)throw Error('商品を選択してください');
    const groups={};
    for(const l of lines){integer(l.qty,'数量',1);integer(l.price,'単価');if(![8,10].includes(l.rate))throw Error('税率が不正です');
      const amount=l.qty*l.price;integer(amount,'明細金額');groups[l.rate]=(groups[l.rate]||0)+amount;}
    const taxes=Object.entries(groups).map(([rate,net])=>({rate:Number(rate),net,tax:Math.floor(net*Number(rate)/100)}));
    const subtotal=taxes.reduce((n,g)=>n+g.net,0),tax=taxes.reduce((n,g)=>n+g.tax,0),total=subtotal+tax;
    integer(total,'合計',1);return {subtotal,tax,total,taxes};
  }
  function initial(items){return {version:1,revision:0,items:clone(items),sales:[],issuer:{name:'サンプル店舗',regno:'',address:''}};}
  function sell(state,request){
    if(!request.key||!request.id||!request.date)throw Error('取引識別情報が必要です');
    const prior=state.sales.find(s=>s.key===request.key);if(prior)return {state:clone(state),sale:clone(prior),duplicate:true};
    if(state.sales.some(s=>s.id===request.id))throw Error('伝票番号が重複しています');
    if(typeof request.customer!=='string'||!request.customer.trim()||request.customer.length>100)throw Error('宛名を入力してください');
    const next=clone(state),counts={};
    if(!Array.isArray(request.lines)||!request.lines.length)throw Error('商品を選択してください');
    const lines=request.lines.map(l=>{
      const item=next.items.find(i=>i.code===l.code);if(!item)throw Error('商品が見つかりません');
      integer(l.qty,'数量',1);counts[l.code]=(counts[l.code]||0)+l.qty;
      return {code:item.code,name:item.name,qty:l.qty,price:item.price,rate:item.rate||10};
    });
    const amounts=calculate(lines);integer(request.tender,'お預り金',1);if(request.tender<amounts.total)throw Error('お預り金が不足しています');
    for(const [code,qty] of Object.entries(counts)){const item=next.items.find(i=>i.code===code);if(item.qty<qty)throw Error(item.name+'の在庫が不足しています');item.qty-=qty;}
    const sale={id:request.id,key:request.key,date:request.date,created:request.created||request.date,customer:request.customer.trim(),lines,...amounts,tender:request.tender,change:request.tender-amounts.total,method:'現金',issuer:clone(next.issuer),status:'確定'};
    next.sales.unshift(sale);next.revision++;return {state:next,sale};
  }
  function refund(state,id,date){
    const next=clone(state),sale=next.sales.find(s=>s.id===id);if(!sale)throw Error('取引が見つかりません');
    if(sale.status==='取消')return {state:next,sale,duplicate:true};
    for(const l of sale.lines){const item=next.items.find(i=>i.code===l.code);if(!item)throw Error('商品マスターが見つかりません');item.qty+=l.qty;}
    sale.status='取消';sale.refundDate=date;next.revision++;return {state:next,sale};
  }
  function journals(sales){
    const list=[];
    for(const s of sales){
      const rows=[{debit:'1001',credit:'4001',amount:s.subtotal},{debit:'1001',credit:'2100',amount:s.tax}].filter(x=>x.amount>0);
      rows.forEach((r,i)=>list.push({...r,id:'sr-'+s.id+'-'+i,date:s.date,memo:'レジ売上｜'+s.id,taxLabel:'税率別計算',source:'smart-register'}));
      if(s.status==='取消')rows.forEach((r,i)=>list.push({...r,debit:r.credit,credit:r.debit,id:'sr-refund-'+s.id+'-'+i,date:s.refundDate,memo:'レジ取消・返金｜'+s.id,taxLabel:'税率別計算',source:'smart-register'}));
    }return list;
  }
  return {calculate,initial,sell,refund,journals};
});
