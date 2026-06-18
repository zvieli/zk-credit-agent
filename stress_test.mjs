async function stressTest() {
    const addresses = [
        "0x4a4E5DF4874e405912b3cAb2cD18B889ad4bE220",
        "0xc20490E8306257Df636E23BE02a291B553f341EC",
        "0x6CF9dDa93EaF0d51B3A1EDe4c9F5A0061DbD1081",
        "0x8B278B5aB244a2812FA2e4287139c1Db823419bb",
        "0x3Ee505bA316879d246a8fD2b3d7eE63b51B44FAB",
        "0x62F94046888e13ba6F0db3C4c3ED1b587761C4E8",
        "0xbB182d047e794A7190F1E7205B5E4a7F6D66916a",
        "0x8011d0c9DB37CBCF7cA781918B4AD0cB50A177D4",
        "0xbB689122452Ab57B039Ac2076cD9F7b2A8984D20",
        "0x736DdE3E0F5c588dDC53ad7f0F65667C0Cca2801"
    ];

    console.log(`🚀 Starting Stress Test with ${addresses.length} concurrent requests...`);

    const requests = addresses.map(async (addr, index) => {
        try {
            console.log(`[${index}] Sending request for ${addr}...`);
            const response = await fetch('http://localhost:3001/api/generate-loan-proof', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userAddress: addr,
                    blockNumber: "20000000"
                })
            });
            const data = await response.json();
            console.log(`[${index}] Response:`, data);
            return data.jobId;
        } catch (error) {
            console.error(`[${index}] Request failed:`, error.message);
        }
    });

    const jobIds = await Promise.all(requests);
    console.log('\n✅ All requests enqueued. Job IDs:', jobIds.filter(Boolean));

    console.log('\n⏳ Waiting 30 seconds for processing to start, then polling status...');
    await new Promise(r => setTimeout(r, 30000));

    for (const jobId of jobIds) {
        if (!jobId) continue;
        try {
            const statusResponse = await fetch(`http://localhost:3001/api/proof-status/${jobId}`);
            const statusData = await statusResponse.json();
            console.log(`📊 Job ${jobId} Status:`, statusData.status);
        } catch (error) {
            console.error(`📊 Failed to get status for Job ${jobId}:`, error.message);
        }
    }
}

stressTest().catch(console.error);
