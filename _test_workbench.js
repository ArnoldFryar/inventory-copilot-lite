const assert=require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { app } = require('./server');
(async()=>{
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port;
  const executablePath = process.env.TEST_CHROMIUM_PATH;
  const browser = await chromium.launch(executablePath ? {
    executablePath,
    args: ['--no-sandbox', '--single-process', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-software-rasterizer', '--disable-webgl', '--no-zygote', '--in-process-gpu'],
  } : {});
  const screenshots = process.env.TEST_SCREENSHOT_DIR;
  try {
    const page=await browser.newPage();
    const faults=[];
    page.on('pageerror',error=>faults.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(url) ? route.continue() : route.abort());
    const viewportResults=[];
    for(const [width,height] of [[1440,900],[1024,768],[390,844],[320,780]]) {
      await page.setViewportSize({width,height});
      await page.goto(url);
      await page.getByRole('button',{name:'Run sample',exact:true}).waitFor();
      assert.equal(await page.locator('#analysisOverview').isVisible(),false);
      assert((await page.locator('#loadSampleBtn').boundingBox()).y < height);
      if (screenshots) await page.screenshot({ path: path.join(screenshots, 'updated-upload-' + width + '.png') });
      const start=Date.now();
      await page.getByRole('button',{name:'Run sample',exact:true}).click();
      await page.getByRole('heading',{name:'Sample inventory review'}).waitFor();
      const sampleMs=Date.now()-start;
      assert.equal(await page.locator('#resultsSection').isVisible(),true);
      const first=await page.locator('#resultsBody tr').first().boundingBox();
      if (screenshots) await page.screenshot({ path: path.join(screenshots, 'updated-results-' + width + '.png') });
      assert(first && first.y < height);
      if (width === 390) {
        const second = await page.locator('#resultsBody tr').nth(1).boundingBox();
        assert(second && second.y + second.height <= height, 'Two exceptions should be visible at 390 px: ' + JSON.stringify({ first, second }));
      }
      const actual=await page.evaluate(()=>document.documentElement.scrollWidth);
      viewportResults.push({width,actual,firstRowTop:first.y,sampleMs});
      assert(actual<=width,'Unexpected horizontal overflow at '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'New analysis'}).click();
    const custom=Buffer.from('Material code,Physical stock,Consumption 90D,Replenishment weeks,Site,Description\n00042,25,900,2,NW,Widget\n00043,0,450,2,NW,Bracket');
    await page.locator('#csvfile').setInputFiles({name:'different-erp.csv',mimeType:'text/csv',buffer:custom});
    await page.getByRole('button',{name:'Analyze inventory',exact:true}).click();
    await page.getByRole('heading',{name:'Review column mapping'}).waitFor();
    await page.locator('[name=part_number]').selectOption('Material code');
    await page.locator('[name=on_hand]').selectOption('Physical stock');
    await page.locator('[name=daily_usage]').selectOption('Consumption 90D');
    await page.locator('[name=lead_time]').selectOption('Replenishment weeks');
    await page.locator('#mappingUsageBasis').selectOption('total');
    await page.locator('#mappingUsageDays').fill('90');
    await page.locator('#mappingLeadUnits').selectOption('calendar_weeks');
    await page.getByRole('button',{name:'Analyze with this mapping'}).click();
    await page.getByRole('heading',{name:'Inventory review',exact:true}).waitFor();
    await page.getByRole('button',{name:'Details for 00042 at NW'}).click();
    const details=await page.locator('#inventoryRowBody').innerText();
    assert.match(details,/2.5 d/);
    assert.match(details,/14 d/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#inventoryRowDetails').isVisible(),false);
    await page.getByRole('searchbox',{name:'Search part or site'}).fill('does-not-match');
    await page.getByText('No rows match these filters.').waitFor();
    await page.getByRole('button',{name:'Clear filters'}).click();
    await page.getByRole('button',{name:'Details for 00042 at NW'}).waitFor();
    await page.getByRole('button',{name:'New analysis'}).click();
    await page.locator('#csvfile').setInputFiles({name:'not-inventory.txt',mimeType:'text/plain',buffer:Buffer.from('Invalid upload')});
    await page.getByRole('button',{name:'Analyze inventory',exact:true}).click();
    await page.locator('#errorBanner').filter({hasText:'Only .csv and .xlsx files are accepted.'}).waitFor();
    assert.equal(await page.locator('#previousRunNote').isVisible(),true);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'updated-upload-error-390.png') });
    await page.locator('#csvfile').setInputFiles({name:'qty-only.csv',mimeType:'text/csv',buffer:Buffer.from('SKU,Qty On Hand\n00001,0\n00002,100')});
    await page.getByRole('button',{name:'Analyze inventory',exact:true}).click();
    await page.getByRole('heading',{name:'Review column mapping'}).waitFor();
    await page.getByRole('button',{name:'Analyze with this mapping'}).click();
    await page.getByText('No shortage rating is available. Review missing or invalid inputs.').waitFor();
    assert.equal(await page.locator('#metricZero').innerText(),'1');
    assert.equal(await page.locator('#metricUrgent').innerText(),'—');
    await page.getByRole('button',{name:'New analysis'}).click();
    await page.locator('#csvfile').setInputFiles({name:'healthy.csv',mimeType:'text/csv',buffer:Buffer.from('SKU,Qty On Hand,ADU,Lead Time\n00001,40,4,10')});
    await page.getByRole('button',{name:'Analyze inventory',exact:true}).click();
    await page.getByText('No shortages detected in 1 scored row.').waitFor();
    assert.equal(await page.locator('#metricUrgent').innerText(),'0');
    assert.deepEqual(faults,[]);
    console.log(JSON.stringify(viewportResults));
    console.log('Mapping, unit conversion, missing inputs, no matches, recovery, and keyboard dialog close passed.');
  } finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
