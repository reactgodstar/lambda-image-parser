function makeResult(s3Key, fileSizeIn, fileSizeOut, duration) {
		
		/* calculate byte reduction and percentage decrease */
			
		var decrease = fileSizeIn - fileSizeOut;
		decrease = Math.round( ( decrease / fileSizeIn ) * 100) ;

		/* build and json encode result to sent to client (front end ) */
		
    return JSON.stringify({
        'url': 'https://images.imagereduce.com/' + s3Key,
        'bytes_before': humanFileSize( fileSizeIn ),
        'bytes_after': humanFileSize( fileSizeOut ),
        'bytes_reduced': humanFileSize( fileSizeIn - fileSizeOut ),
        'percent_reduced': decrease + '%',
        'duation': ( duration / 1000 ),
    });
}

function makeWriteParams(bucketOut, keyOut, bodyData, imageType) {

    return writeParams = {
        'Bucket': bucketOut,
        'Key': keyOut,
        'ContentType': 'image/'.imageType,
        'ACL': 'public-read',
        'Body': bodyData
    };
} 

function humanFileSize(size) {
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    var i = 0;
    while(size >= 1024) {
        size /= 1024;
        ++i;
    }
    return Math.round(size) + ' ' + units[i];
}

function deleteObj( s3, key, bucket ) {

	var delParams = {
	  Bucket: bucket,
	  Key: key
	};
	
	s3.deleteObject(delParams, function(err, data) {
	  if (err) 
	  	console.log(err, err.stack); //error
	  else
	  	console.log(data); //success
	});	
}

function getFileExtension( file ) {
	
	return file.split('.').pop().toLowerCase();
} 


function getFileInfo(request, uri){
    return new Promise((resolve, reject) => {
        request.head(uri, (err, res, body) => 
            err ? reject(err)
                : resolve({
                    contentType: res.headers['content-type'],
                    contentLength: res.headers['content-length']
                })
        ); 
    });
};

exports.handler = async (event, context, callback) => {
			
		/* get quality factor settings for each image type (from payload or set defaults) */
		
		const jpgQuality = ( event.jpg_quality ) ? event.jpg_quality : 75 ;
		
		const pngColors = ( event.png_colors ) ? event.png_colors : 96; 
		const pngQuality = ( event.png_quality ) ? event.png_quality : '60-80'; 
		
		const gifColors = ( event.gif_colors ) ? gif_colors : 192;
		const gifLossyVal = ( event.gif_lossy_val ) ? gif_lossy_val : 80;
			
		/* incoming image details */
		
    let keyIn = event.s3_key;	 	//s3 key (filename) of incoming image
    let keyOut = keyIn;	 				//s3 key for output/optimized image

    if (event.image_url) {
        keyIn = event.image_url.split('/').pop();
        keyOut = Date.now() + '/' + keyIn; 
    }
    
		/* determine image type (ie jpg, jpeg, gif, png */
    
    let imageType = getFileExtension( keyIn ); //get file extension from keyIn to determinate image type (png, jpg, gif)
    imageType = (imageType == 'jpeg') ? 'jpg' : imageType;
    
    /* make sure image type is supported. if not, exit function completely */ 
		
	const allowedExt = [ 'jpg', 'jpeg', 'png', 'gif' ];
	
	if( allowedExt.indexOf( imageType ) == -1 ) { 
		return context.fail('error: image type "' + imageType + '" not supported');
	}

    /* set variables */    

    const bucketIn = 'cdn-ir-inbound'; //s3 bucket where incoming file resides
    const bucketOut = event.s3_bucket_out; //destination s3 bucket to place optimized image into

    const fileBase = '/tmp/' + Date.now();
    const localFileIn = fileBase + '-in.tmp'; //if image has to be written to local file to be optimized, use this filename
    const localFileIn1 = fileBase + '-in1.tmp'; //if image has to be written to local file to be optimized, use this filename
    const localFileOut = fileBase + '-out.tmp'; //if image has to be written to local file to be optimized, use this filename

    var fileSizeIn = 0; //initial file size (bytes) of original/incoming image file
    var fileSizeOut = 0; //file size of compressed image 
    var startTime = Date.now(); //start time, used for tracking compression duration

		/* load libraries */
		
    const aws = require('aws-sdk');
    const fs = require('fs');
    const request = require('request');

    const s3 = new aws.S3();
    
    let readStream, writeStream;
    let fileInfo = {};

	
	/* this is an image so we must fetch the image and put it into stream to use below */

	//TODO head request for content length
	
    try {
        if (event.image_url) {
            fileInfo = await getFileInfo( request, event.image_url );
        }
    } catch( err ) {
        console.log(err);
        context.fail(err);
    }
	console.log('==> fileInfo: ', fileInfo);


    switch (imageType) {

        case 'jpg':
            const JpegTran = require('jpegtran'),
                myJpegTranslator = new JpegTran(['-copy', 'none', '-optimize', '-progressive']);

            const mozjpeg = require('mozjpeg-stream');

            await new Promise( async (resolve, reject) => {

                if (event.image_url) {
                    readStream = request( event.image_url );
                } else {
                    const readParams = {
                        Bucket: bucketIn,
                        Key: keyIn
                    };
                    readStream = s3.getObject(readParams).createReadStream();
                }

                writeStream = fs.createWriteStream(localFileIn);

                const gm = require('gm').subClass({
                    imageMagick: true
                });

                readStream.on('data', (chunk) => {
                    fileSizeIn += chunk.length;
                });

                gm(readStream).quality( jpgQuality ).strip().compress('jpeg')
                    .stream((err, stdout, stderr) =>
                        stdout.pipe(myJpegTranslator).pipe(mozjpeg({ quality: jpgQuality })).pipe(writeStream).on('finish', (fd) => {

                            fs.readFile(localFileIn, (err, data) => {
                                if (err) {
                                    console.log(err);
                                    return context.fail(err);
                                }

                                var fileSizeOut = data.length; 
                                var writeParams = makeWriteParams(bucketOut, keyOut, data, imageType);

                                s3.upload(writeParams, async(err, data) => {
                                    if (err) {
                                        console.log(err);
                                        return context.fail(err);
                                    }
    																		
    																	/* delete local file */
    																	
                                    fs.unlinkSync(localFileIn);

                            				/* delete file off s3 */
                            				
                            				deleteObj( s3, keyIn, bucketIn );
                            				
                            				/* make/show result */
                            				
                                    callback(
                                        null,
                                        makeResult(
                                            keyOut,
                                            fileSizeIn,
                                            fileSizeOut,
                                            Date.now() - startTime
                                        )
                                    );
                                });
                            });;
                        })
                    );

                });


            break;

        case 'png':

            const PngQuant = require('pngquant'),
                myPngQuanter = new PngQuant([pngColors, '--quality', pngQuality]); //colors (ie 96) and quality factor (ie 60-80)


            await new Promise( async (resolve, reject) => {

                if (event.image_url) {
                    readStream = request( event.image_url );
                } else {
                    const readParams = {
                        Bucket: bucketIn,
                        Key: keyIn
                    };
                    readStream = s3.getObject(readParams).createReadStream();
                }
            
                writeStream = fs.createWriteStream(localFileIn);

                readStream.on('data', (chunk) => {
                    fileSizeIn += chunk.length;
                });

                readStream.pipe(myPngQuanter).pipe(writeStream).on('finish', (fd) => {
                    fs.readFile(localFileIn, (err, data) => {
                        if (err) {
                            console.log(err);
                            return context.fail(err);
                        }

                        var fileSizeOut = data.length;
                        var writeParams = makeWriteParams(bucketOut, keyOut, data, imageType);

                        s3.upload(writeParams, async(err, data) => {
                            if (err) {
                                console.log(err);
                                return context.fail(err);
                            }
                      
    													/* delete local file */
    													
                              fs.unlinkSync(localFileIn);

                      				/* delete file off s3 */
                      				
                      				deleteObj( s3, keyIn, bucketIn );

                            callback(
                                null,
                                makeResult(
                                    keyOut,
                                    fileSizeIn,
                                    fileSizeOut,
                                    Date.now() - startTime
                                )
                            );
                        });
                    });
                });

            });

            break;

        case 'gif':

            const { execFile } = require('child_process');
            const giflossy = require('giflossy');
            const gifsicle = require('gifsicle');

            await new Promise( async (resolve, reject) => {

                if (event.image_url) {
                    readStream = request( event.image_url );
                } else {
                    const readParams = {
                        Bucket: bucketIn,
                        Key: keyIn
                    };
                    readStream = s3.getObject(readParams).createReadStream();
                }


                writeStream = fs.createWriteStream(localFileIn1);

                readStream.on('data', (chunk) => {
                    fileSizeIn += chunk.length;
                });

                readStream.pipe(writeStream).on('finish', (fd) => {

                    execFile(gifsicle, ['--colors', gifColors, '-o', localFileIn, localFileIn1], {
                        maxBuffer: 1024 * 1024 * 50
                    }, err => {

                        if (err) {
                           // console.log(err);
                             return context.fail( err );
                        }

                        execFile(giflossy, ['-O3', '--lossy=' + gifLossyVal, '-o', localFileOut, localFileIn], {
                            maxBuffer: 1024 * 1024 * 50
                        }, err => {
                            if (err) {
                                //console.log(err);
                                 return context.fail( err );
                            }

                            fs.readFile(localFileOut, (err, data) => {
                                if (err) {
                                    //console.log(err);
                                     return context.fail( err );
                                }

                                var fileSizeOut = data.length;
                                var writeParams = makeWriteParams(bucketOut, keyOut, data, imageType);

                                s3.upload(writeParams, async(err, data) => {
                                    if (err) {
                                        //console.log(err);
                                         return context.fail( err );
                                    }

    																	/* delete local files */
    																	
                                    fs.unlinkSync(localFileIn);
                                    fs.unlinkSync(localFileIn1);
                                    fs.unlinkSync(localFileOut); 

                            				/* delete file off s3 */
                            				
                            				deleteObj( s3, keyIn, bucketIn );

                                    callback(
                                        null,
                                        makeResult(
                                            keyOut,
                                            fileSizeIn,
                                            fileSizeOut,
                                            Date.now() - startTime
                                        )
                                    );
                                });
                            });
                        });
                    });
                });

            });

            break;

    }


    /* if e-mail should be sent, post sns topic to invoke lambda function that will send email */
    /*
    var sendEmail = true;

    if( sendEmail ) {

    var snsParams = {
    Message: JSON.stringify({}), 
    //Subject: "Test SNS From Lambda",
    TopicArn: "arn:aws:sns:us-west-2:123456789012:test-topic1"
    };

    var sns = new AWS.SNS();
    sns.publish( snsParams, context.done );
    }
    */
    
    //console.log('bye');

}