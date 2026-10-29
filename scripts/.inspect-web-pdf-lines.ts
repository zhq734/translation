import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs: any = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule)
;(globalThis as any).pdfjsWorker = ('default' in workerModule ? workerModule.default : workerModule)
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf')), verbosity: 0 }).promise
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k,v])=>[v,k]))
for (const n of [1,2]) {
  const page = await doc.getPage(n)
  const viewport = page.getViewport({scale:1})
  const ops = await page.getOperatorList()
  let current = viewport.transform
  const stack:any[]=[]
  let fill='', stroke='', lw=1
  const out:any[]=[]
  for(let i=0;i<ops.fnArray.length;i++){
    const name=names[ops.fnArray[i]]; const args=ops.argsArray[i] as any
    if(name==='save') stack.push({current,fill,stroke,lw})
    else if(name==='restore'){const s=stack.pop(); if(s)({current,fill,stroke,lw}=s)}
    else if(name==='transform') current=args[0]
    else if(name==='paintFormXObjectBegin'){stack.push({current,fill,stroke,lw}); if(args?.[0]) current=args[0]}
    else if(name==='paintFormXObjectEnd'){const s=stack.pop(); if(s)({current,fill,stroke,lw}=s)}
    else if(name==='setFillRGBColor') fill=`rgb(${args.join(',')})`
    else if(name==='setStrokeRGBColor') stroke=`rgb(${args.join(',')})`
    else if(name==='setFillGray') fill=`gray(${args[0]})`
    else if(name==='setStrokeGray') stroke=`gray(${args[0]})`
    else if(name==='setLineWidth') lw=args[0]
    else if(name==='constructPath'){
      const sub=args?.[0] as number[]; const coords=args?.[1] as number[]
      if(!sub||!coords) continue
      let ai=0
      for(let j=0;j<sub.length;j++){
        const op=sub[j]
        if(op===pdfjs.OPS.rectangle){const x=coords[ai++],y=coords[ai++],w=coords[ai++],h=coords[ai++]; const p=(x:number,y:number)=>[current[0]*x+current[2]*y+current[4],current[1]*x+current[3]*y+current[5]]; const a=p(x,y),b=p(x+w,y+h); out.push({i,op:'rect',x1:Math.min(a[0],b[0]),x2:Math.max(a[0],b[0]),y1:Math.min(a[1],b[1]),y2:Math.max(a[1],b[1]),fill,stroke,lw})}
        else if(op===pdfjs.OPS.moveTo||op===pdfjs.OPS.lineTo){const x=coords[ai++],y=coords[ai++]; const px=current[0]*x+current[2]*y+current[4],py=current[1]*x+current[3]*y+current[5]; out.push({i,op:op===pdfjs.OPS.moveTo?'m':'l',x:px,y:py,fill,stroke,lw})}
        else if(op===pdfjs.OPS.closePath){out.push({i,op:'c',fill,stroke,lw})}
        else if(op===pdfjs.OPS.curveTo){ai+=6;out.push({i,op:'curve',fill,stroke,lw})}
        else if(op===pdfjs.OPS.curveTo2||op===pdfjs.OPS.curveTo3){ai+=4;out.push({i,op:'curve',fill,stroke,lw})}
      }
    } else if(['fill','eoFill','fillStroke','closeFillStroke','eoFillStroke','closeEOFillStroke','stroke','closeStroke','endPath','clip','eoClip'].includes(name)){
      out.push({i,op:name,fill,stroke,lw})
    }
  }
  console.log(`\n=== PAGE ${n} straight/rect paths ===`)
  for(const o of out){ if(o.op==='rect' || o.op==='m'||o.op==='l'||o.op==='c'||['fill','eoFill','fillStroke','closeFillStroke','eoFillStroke','closeEOFillStroke','stroke','closeStroke'].includes(o.op)) {
    if(o.op==='rect' && (o.y1<100||o.y1>800)) continue
    console.log(JSON.stringify(o))
  }}
}
