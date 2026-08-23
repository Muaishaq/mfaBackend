const crypto = require('crypto');
const prisma = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { initiatePayment, verifyPayment } = require('../services/paystack.service');
const { COURSE_TYPES, PAYMENT_STATUS, PAYSTACK_EVENT_TYPES } = require('../constants');
const { sendEnrollmentConfirmation } = require('../services/email.service');

// @desc    Initiate payment for a course
// @route   POST /api/payments/initiate
// @access  Private (student)
const initiate = asyncHandler(async (req, res) => {
  const { course_id } = req.body;

  if (!course_id) {
    return res.status(400).json({
      success: false,
      message: 'Please provide a course ID'
    });
  }

  // Get course
  const course = await prisma.course.findUnique({
    where: { id: course_id }
  });

  if (!course) {
    return res.status(404).json({
      success: false,
      message: 'Course not found'
    });
  }

  if (course.type === COURSE_TYPES.FREE || course.type === COURSE_TYPES.PROMO) {
    return res.status(400).json({
      success: false,
      message: 'This course is free — no payment required'
    });
  }

  // Check if already enrolled
  const existingEnrollment = await prisma.enrollment.findFirst({
    where: {
      student_id: req.user.id,
      course_id,
      status: 'active'
    }
  });

  if (existingEnrollment) {
    return res.status(400).json({
      success: false,
      message: 'You are already enrolled in this course'
    });
  }

  // Generate unique reference
  const reference = `TECHMFA-${crypto.randomUUID()}`;

  // Create pending payment record
  await prisma.payment.create({
    data: {
      student_id: req.user.id,
      course_id,
      amount: course.price,
      currency: 'NGN',
      paystack_ref: reference,
      status: PAYMENT_STATUS.PENDING
    }
  });

  // Initialize payment with Paystack
  const paystackResponse = await initiatePayment(
    req.user.email,
    Number(course.price),
    reference,
    {
      course_id,
      student_id: req.user.id,
      course_title: course.title
    }
  );

  if (!paystackResponse.status) {
    return res.status(400).json({
      success: false,
      message: 'Payment initialization failed'
    });
  }

  res.json({
    success: true,
    message: 'Payment initialized',
    data: {
      authorization_url: paystackResponse.data.authorization_url,
      reference
    }
  });
});

// @desc    Verify payment after redirect
// @route   GET /api/payments/verify/:reference
// @access  Private (student)
const verify = asyncHandler(async (req, res) => {
  const { reference } = req.params;

  const paystackResponse = await verifyPayment(reference);

  if (!paystackResponse.status || paystackResponse.data.status !== PAYMENT_STATUS.SUCCESS) {
    return res.status(400).json({
      success: false,
      message: 'Payment verification failed'
    });
  }

  const payment = await prisma.payment.findUnique({
    where: { paystack_ref: reference }
  });

  if (!payment) {
    return res.status(404).json({
      success: false,
      message: 'Payment record not found'
    });
  }

  res.json({
    success: true,
    message: 'Payment verified successfully',
    data: { payment }
  });
});

// @desc    Paystack webhook
// @route   POST /api/payments/webhook
// @access  Public (Paystack only)
const webhook = async (req, res) => {
  try {
    // Step 1: Verify Paystack signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ message: 'Invalid signature' });
    }

    // Step 2: Parse event
    const event = JSON.parse(req.body);

    // Step 3: Only handle successful charges
    if (event.event !== PAYSTACK_EVENT_TYPES.CHARGE_SUCCESS) {
      return res.status(200).json({ message: 'Event ignored' });
    }

    const { reference } = event.data;

    // Step 4: Idempotency check — don't process twice
    const existingPayment = await prisma.payment.findUnique({
      where: { paystack_ref: reference }
    });

    if (!existingPayment) {
      return res.status(200).json({ message: 'Payment not found' });
    }

    if (existingPayment.status === PAYMENT_STATUS.SUCCESS) {
      return res.status(200).json({ message: 'Already processed' });
    }

    // Step 5: Update payment status
    await prisma.payment.update({
      where: { paystack_ref: reference },
      data: {
        status: PAYMENT_STATUS.SUCCESS,
        paid_at: new Date()
      }
    });

    // Step 6: Create enrollment
    const enrollment = await prisma.enrollment.create({
      data: {
        student_id: existingPayment.student_id,
        course_id: existingPayment.course_id,
        status: 'active'
      }
    });

    // Step 7: Send confirmation email to student (async, non-blocking)
    const user = await prisma.user.findUnique({ where: { id: existingPayment.student_id } });
    const course = await prisma.course.findUnique({ where: { id: existingPayment.course_id } });
    if (user && course) {
      sendEnrollmentConfirmation(user, course);
    }

    // Step 8: Create in-app notification
    await prisma.notification.create({
      data: {
        user_id: existingPayment.student_id,
        title: 'Enrollment Successful! 🎉',
        message: 'Your payment was confirmed. You now have full access to your course.'
      }
    });

    // Step 9: Return 200 OK to Paystack
    return res.status(200).json({ message: 'Webhook processed successfully' });

  } catch (error) {
    // Log removed per Section 4.1 - No console.log in production code
    // TODO: Implement proper logger (winston/pino) per Section 4.1
    // Still return 200 so Paystack doesn't retry endlessly
    return res.status(200).json({ message: 'Webhook received' });
  }
};

// @desc    Get all payments (admin)
// @route   GET /api/payments
// @access  Admin
const getPayments = asyncHandler(async (req, res) => {
  const payments = await prisma.payment.findMany({
    include: {
      student: {
        select: { id: true, full_name: true, email: true }
      },
      course: {
        select: { id: true, title: true, academy: true }
      }
    },
    orderBy: { created_at: 'desc' }
  });

  res.json({
    success: true,
    message: 'Payments retrieved successfully',
    data: { payments }
  });
});

module.exports = { initiate, verify, webhook, getPayments };