// Use before importing index.js (getJpegExifFilter)
(<any>global).jpegAppFilterStreamLogLevel = 1;



import { join } from "path";
import { tmpdir } from "os";
import { createWriteStream } from "fs";
import { eLogLevel, getJpegAppFilterStream } from "../jpeg-app-filter-stream";
import { Readable, Writable } from "stream";



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


let firstRead = true;
let lastRead = false;
let finishReading = false;

let rwSequnce: Array<"R" | "w"> = [];

const BYTES_IN_100_MB = 104857600;

async function test() {
    console.log("Starting (check momory consumption and final result after sigbreak");


    let bytesReaded = 0;
    let numOf100MbChunksReaded = 0;

    let source = new Readable({

        read(size: number) {
            rwSequnce.push("R");

            if (finishReading) {
                setTimeout( () => {
                    this.push(null);
                }, 0);
            }
            else {
                if (size < 4) {
                    size = 4;
                }
                let data = Buffer.from( (new Uint8Array(size)).fill(0x20) );
                if (firstRead) {
                    firstRead = false;

                    // SOI
                    data[0] = 0xFF;
                    data[1] = 0xD8;

                    // SOS
                    data[2] = 0xFF;
                    data[3] = 0xDA;
                }

                if (lastRead) {
                    lastRead = false;
                    finishReading = true;

                    let lastIndex = data.length - 1;
                    data[lastIndex -1] = 0xFF;
                    data[lastIndex]    = 0xD9;
                }

                setTimeout( () => {

                    bytesReaded += size;
                    let nextGbReaded = Math.floor( bytesReaded / BYTES_IN_100_MB );
                    if (nextGbReaded) {
                        bytesReaded = bytesReaded % BYTES_IN_100_MB;
                        numOf100MbChunksReaded += nextGbReaded;
                        console.log(`  Readed ${numOf100MbChunksReaded * 100} MB total`);
                    }

                    this.push(data);
                }, 0);
            }
        }
    });


    let bytesWritten = 0;
    let numOf100MbChunksWrited = 0;

    let destination = new Writable({
        write(chunk, _enc, callback) {
            rwSequnce.push("w");

            setTimeout(() => {
                bytesWritten += chunk.length;
                let nextGbWritten = Math.floor( bytesWritten / BYTES_IN_100_MB );
                if (nextGbWritten) {
                    bytesWritten = bytesWritten % BYTES_IN_100_MB;
                    numOf100MbChunksWrited += nextGbWritten;
                    console.log(`    Writed ${numOf100MbChunksWrited * 100} MB total`);
                }

                callback();
            }, 0);
        }
    });

    let filter = getJpegAppFilterStream();


    source
        .pipe(filter)
        .pipe(destination);


    destination.on("finish", () => {
        console.log(`Readed  ${ (numOf100MbChunksReaded * 100 + bytesReaded / 1048576).toFixed(1) } MB  total`);
        console.log(`Writed  ${ (numOf100MbChunksWrited * 100 + bytesWritten / 1048576).toFixed(1) } MB  total`);

        console.log(`R/W sequence ${isRwSequenceOk() ? "OK" :"suspicious!!!!   Please investigate."}`);
    });


    console.log(`# Creating 5 GB file in tmp dir`);

}

function isRwSequenceOk() {
    let sequence =  rwSequnce.join("");
    let ok = ! /(RRRR|wwww)/.test( sequence ); // unwanted sequence
    ok = ok && (/RwRw/).test( sequence ); // desired sequence (assuming the same high water mark on each pipeline element)

    return ok;
}

process.on("SIGINT", function() {
    console.log("Stopping");
    lastRead = true;
});

test();
