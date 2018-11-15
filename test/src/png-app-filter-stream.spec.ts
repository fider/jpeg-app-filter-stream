import {Writable, Readable } from "stream";
import { createReadStream } from "fs";
import * as fsExtra from "fs-extra";
import { join } from "path";

// (<any>global).pngAppFilterStreamLogLevel = 2;
import { getPngAppFilterStream } from "../../src/png-app-filter-stream";



const pngWithExif = join(__dirname, "../../assets/thexifer.net.png");
const pngNoExif = join(__dirname, "../../assets/clean.png");

let expectedImageWihoutExif: Buffer;
const jasmineDefaultTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;



describe("PngAppFilterStream", function() {


    beforeAll( async function(done: DoneFn) {

        expectedImageWihoutExif = await fsExtra.readFile(pngNoExif);
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

        done();
    });


    afterAll( async function(done: DoneFn) {

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



    describe("E2E test for destination that consume data immediately (filter.push causes that destination will call filter._read before"
           + "filter.push will return).", function() {


        for (let hwm of highWaterMarks) {


            it(`Should properly remove exif from png file when highWaterMark of source=${hwm.source || "default"} ` +
               `PngExifFilter=${hwm.filter || "default"} destination=${hwm.destination || "default"}. `,
                async function(done: DoneFn) {

                //
                // Prepare
                //
                let output: Buffer[] = [];

                const source = createReadStream( pngWithExif, {
                    highWaterMark: hwm.source
                });

                const filter = getPngAppFilterStream({
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
                    fail(`FAIL of PngExifFilter: ${err}`);
                });
                destination.on("error", function (err) {
                    fail(`FAIL of destination: ${err}`);
                });

                destination.on("finish", function() {

                    let result = Buffer.concat(output);

                    if ( ! result.equals(expectedImageWihoutExif)) {
                        fail(`Result differs from expectations`);
                    }

                    done();
                });

            });


        }
    });



    describe("E2E test for destination that consume data with delay.", function() {


        for (let hwm of highWaterMarks) {


            it(`Should properly remove exif from png file when highWaterMark of source=${hwm.source || "default"} ` +
               `PngExifFilter=${hwm.filter || "default"} destination=${hwm.destination || "default"}. `,
                async function(done: DoneFn) {

                //
                // Prepare
                //
                let output: Buffer[] = [];

                const source = createReadStream( pngWithExif, {
                    highWaterMark: hwm.source
                });

                const filter = getPngAppFilterStream({
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
                    fail(`FAIL of PngExifFilter: ${err}`);
                });
                destination.on("error", function (err) {
                    fail(`FAIL of destination: ${err}`);
                });

                destination.on("finish", function() {

                    let result = Buffer.concat(output);

                    if ( ! result.equals(expectedImageWihoutExif)) {
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


            let input: Buffer = await fsExtra.readFile(pngNoExif);
            const source = new Readable({
                highWaterMark: 12,
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


            const filter = getPngAppFilterStream({
                highWaterMark: 12
            });


            const destination = new Writable({
                highWaterMark: 3,
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
                fail(`FAIL of PngExifFilter: ${err}`);
            });
            destination.on("error", function (err) {
                fail(`FAIL of destination: ${err}`);
            });

            destination.on("finish", function() {

                let result = Buffer.concat(output);

                if ( ! result.equals(expectedImageWihoutExif)) {
                    fail(`Result differs from expectations`);
                }

                if (operations.join("").indexOf("SSDSSSDDSDSDDSDSDSDDD") === -1) {
                    fail(`Seems that backpressure is not working as expected. Details: Sequence of Source/Destination: "${operations.join("")}"`);
                }

                done();
            });

        });
    });


});
