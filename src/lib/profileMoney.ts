export function lkrToMinor(value:string){
  if(!/^\d{1,7}(\.\d{1,2})?$/.test(value.trim()))throw Error('Enter a valid LKR amount with up to two decimal places.');
  const [whole,fraction='']=value.trim().split('.');const minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(minor>100000000)throw Error('The starting rate must be LKR 1,000,000 or less.');return minor;
}

const lkr = new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR', currencyDisplay: 'code' });
export const formatLkr = (minor: number) => lkr.format(minor / 100);
