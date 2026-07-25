const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
(async()=>{const pay=await p.payment.findUnique({where:{id:'cmrz8w2z1000dxsc2qu6zrrc4'}});console.log(pay.refNo);await p.$disconnect();})();
