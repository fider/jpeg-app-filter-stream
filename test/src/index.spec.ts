import { DuplexOptions, ReadableOptions, WritableOptions, Writable, Readable } from "stream";
import { createReadStream, createWriteStream, readFileSync } from "fs";
import * as fsExtra from "fs-extra";
import { join } from "path";
import { getJpegExifFilter } from "../../src/jpeg-app-filter-stream";
import { tmpdir } from "os";
import through2 = require("through2");



const jpegWithExif = join(__dirname, "../../assets/jpg-thexifer.net.jpg");
const jpegNoExif = join(__dirname, "../../assets/clean.jpg");

let expectedImageWihoutExif: string;
let jasmineDefaultTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;


describe("index", function() {


    beforeAll( async function(done: DoneFn) {

        expectedImageWihoutExif = (await fsExtra.readFile(jpegNoExif)).toString();
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

        done();
    });


    afterAll( async function(done: DoneFn) {

        expectedImageWihoutExif = (await fsExtra.readFile(jpegNoExif)).toString();
        jasmine.DEFAULT_TIMEOUT_INTERVAL = jasmineDefaultTimeout;

        done();
    });


    beforeEach( async function(done: DoneFn) {
        done();
    });



    const highWaterMarks = [
        {source: undefined, filter: undefined, destination: undefined},
        {source: 1,         filter: undefined, destination: undefined},
        {source: 9,         filter: undefined, destination: undefined},
        {source: undefined, filter: 1,         destination: undefined},
        {source: undefined, filter: 9,         destination: undefined},
        {source: undefined, filter: undefined, destination: 1},
        {source: undefined, filter: undefined, destination: 9},
        {source: 1,         filter: undefined, destination: 9},
        {source: 9,         filter: undefined, destination: 1},
        {source: 1,         filter: 9,         destination: 28},
        {source: 29,        filter: 10,        destination: 2}
    ];



    describe("E2E test for source that consumes data immediately (filter.push causes that destination will call filter._read before filter.push will return).", function() {


        for (let hwm of highWaterMarks) {


            it(`Should properly remove exif from jpeg file when highWaterMark of source=${hwm.source || "default"} ` +
               `JpegExifFilter=${hwm.filter || "default"} destination=${hwm.destination || "default"}. `,
                async function(done: DoneFn) {

                //
                // Prepare
                //
                let output: Buffer[] = [];

                const source = createReadStream( jpegWithExif, {
                    highWaterMark: hwm.source
                });

                const filter = getJpegExifFilter({
                    highWaterMark: hwm.filter
                });

                const destination = new Writable({
                    highWaterMark: hwm.destination,
                    write(chunk, _enc, callback) {
                        output.push(chunk);
                        callback();
                    }
                });

                //
                // Run
                //
                source
                    .pipe( filter )
                    .pipe( destination );


                //
                // Verify
                //
                source.on("error", function (err) {
                    fail(`FAIL of source: ${err}`);
                });
                filter.on("error", function (err) {
                    fail(`FAIL of JpegExifFilter: ${err}`);
                });
                destination.on("error", function (err) {
                    fail(`FAIL of destination: ${err}`);
                });

                destination.on("finish", function() {

                    let result = Buffer.concat(output).toString();

                    if (result !== expectedImageWihoutExif) {
                        fail(`Result differs from expectations`);
                    }

                    done();
                });

            });


        }
    });



    describe("E2E test for source that consumes data with delay.", function() {


        for (let hwm of highWaterMarks) {


            it(`Should properly remove exif from jpeg file when highWaterMark of source=${hwm.source || "default"} ` +
               `JpegExifFilter=${hwm.filter || "default"} destination=${hwm.destination || "default"}. `,
                async function(done: DoneFn) {

                //
                // Prepare
                //
                let output: Buffer[] = [];

                const source = createReadStream( jpegWithExif, {
                    highWaterMark: hwm.source
                });

                const filter = getJpegExifFilter({
                    highWaterMark: hwm.filter
                });

                const destination = new Writable({
                    highWaterMark: hwm.destination,
                    write(chunk, _enc, callback) {
                        output.push(chunk);
                        setTimeout( callback, 0 );
                    }
                });

                //
                // Run
                //
                source
                    .pipe( filter )
                    .pipe( destination );


                //
                // Verify
                //
                source.on("error", function (err) {
                    fail(`FAIL of source: ${err}`);
                });
                filter.on("error", function (err) {
                    fail(`FAIL of JpegExifFilter: ${err}`);
                });
                destination.on("error", function (err) {
                    fail(`FAIL of destination: ${err}`);
                });

                destination.on("finish", function() {

                    let result = Buffer.concat(output).toString();

                    if (result !== expectedImageWihoutExif) {
                        fail(`Result differs from expectations`);
                    }

                    done();
                });

            });


        }
    });



    describe("E2E test - is backpressure works as expected.", function() {

        it(`Should handle backpressure correctly`, async function(done: DoneFn) {

            //
            // Prepare
            //
            let operations: Array<"S" | "D"> = [];
            let output: Buffer[] = [];


            let input: Buffer = await fsExtra.readFile(jpegWithExif);
            const source = new Readable({
                highWaterMark: 100,
                read(size) {
                    operations.push("S");
                    let data: Buffer | null = input.slice(0, size);
                    input = input.slice(size);

                    if ( ! data.length) {
                        data = null;
                    }
                    this.push(data);
                }
            });


            const filter = getJpegExifFilter({
                highWaterMark: 10
            });


            const destination = new Writable({
                highWaterMark: 10,
                write(chunk, _enc, callback) {
                    operations.push("D");
                    output.push(chunk);
                    setTimeout( callback, 0 );
                }
            });


            //
            // Run
            //
            source
                .pipe( filter )
                .pipe( destination );


            //
            // Verify
            //
            source.on("error", function (err) {
                fail(`FAIL of source: ${err}`);
            });
            filter.on("error", function (err) {
                fail(`FAIL of JpegExifFilter: ${err}`);
            });
            destination.on("error", function (err) {
                fail(`FAIL of destination: ${err}`);
            });

            destination.on("finish", function() {

                let result = Buffer.concat(output).toString();

                if (result !== expectedImageWihoutExif) {
                    fail(`Result differs from expectations`);
                }

                if (operations.join("").indexOf("SDDDDDDDDDDSDDDDDDDDDDDSDDDDDDDDDDSDDDDDDDDDDDSDDDDDDDDDDS") === -1) {
                    fail(`Seems that backpressure is not working as expected.`);
                }

                done();
            });

        });
    });


    xit(`Should not consume whole memory`, async function(done: DoneFn) {

        // console.log("creating file...");
        // let file = await prepareHugeFile();
        // console.log(`done: ${file}`)

        const source = createReadStream(  join(`C:/Users/wfide/AppData/Local/Temp/hugeTmpFile` ), {
            // highWaterMark: hwm.source
        });

        const filter = getJpegExifFilter({
            // highWaterMark: hwm.filter
        });

        // const destination = new Writable({
        //     // highWaterMark: hwm.destination,
        //     write(chunk, _enc, callback) {
        //         // output.push(chunk);
        //         // setTimeout( callback, 0 );
        //         callback();
        //     }
        // });
        const destination = createWriteStream( join(`C:/Users/wfide/AppData/Local/Temp/hugeTmpFile_OUTPUT` ) );

        //
        // Run
        //
        source
            .pipe( filter )
            .pipe( through2 ( function(chunk, enc, callback) {
                // console.log(`processed ${chunk.length}`)
                this.push(chunk);
                callback();
            }))
            .pipe( destination );

        destination.on("finish", function() {
            console.log("DONE");
            done();
        })

    });

});



async function prepareHugeFile() {


    return new Promise( (resolve, reject) => {

        function write() {
            while(writer.write(oneKb)) {

                // if ( (savedKb % 102) === 0) {
                //     console.log(`  100 kb written...`)
                // }

                savedKb++;

                if (  savedKb % 100000 === 0  ) {
                    console.log(`    100 Mb written...`)
                }


                if (savedKb >= limitOfKb) {
                    console.log(`writed ${savedKb}`)
                    writer.end( Buffer.from("FFD9", "hex") );
                    break;
                }
            }
        }

        const filePath = join(tmpdir(), "hugeTmpFile" );
        const writer = createWriteStream( filePath );


        writer.on("finish", function() {
            resolve(filePath);
        });


        writer.write(Buffer.from("FFD8", "hex"));
        writer.write(Buffer.from("FFDA", "hex")); // JPEG SOS marker
        let oneKb = Buffer.from("02".repeat(1024), "hex");

        let savedKb = 0;
        let limitOfKb = 5 * 1000 * 1000;


        writer.on("drain", write);

        write();
    });

}