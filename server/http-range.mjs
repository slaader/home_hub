// One HTTP Range header ("bytes=a-b", "bytes=a-", "bytes=-n") against a file of `size` bytes.
// Throws Error('range') for anything else, including multi-range requests.
export function byteRange(value,size){
 if(!value)return {start:0,end:size-1,status:200};
 const m=/^bytes=(\d*)-(\d*)$/.exec(value);if(!m||(!m[1]&&!m[2]))throw new Error('range');
 const start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2])),end=m[1]?(m[2]?Math.min(Number(m[2]),size-1):size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)throw new Error('range');
 return {start,end,status:206};
}
