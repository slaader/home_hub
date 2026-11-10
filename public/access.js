let identity=null;
export const setIdentity=value=>{identity=value;};
export const currentIdentity=()=>identity;
export const canWrite=()=>identity?.canWrite===true;
export const canAdmin=()=>identity?.canAdmin===true;
